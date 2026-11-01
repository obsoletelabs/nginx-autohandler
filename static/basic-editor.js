/* Basic forms are projections of specific directives, with the rest in Advanced. */
function basicInput(label,value,type='text',hint=''){const input=el('input',{type,value});return {input,wrapper:el('label',{},label,input,hint?el('small',{class:'field-hint',text:hint}):null),initial:String(value??'')};}
function basicCheck(label,value,hint=''){const input=el('input',{type:'checkbox',checked:value});return {input,wrapper:el('label',{class:'basic-checkbox'},input,el('span',{},label,hint?el('small',{text:hint}):null)),initial:!!value};}
function direct(block,name){return block.children.filter(n=>n.kind==='directive'&&n.name===name);}
function fieldToken(token){if(!token)return '';if(token.startsWith('"')&&token.endsWith('"')){try{return JSON.parse(token);}catch{}}if(token.startsWith("'")&&token.endsWith("'"))return token.slice(1,-1);return token;}
function isWebsocketHeader(node){return node.name==='proxy_set_header'&&['upgrade','connection'].includes(fieldToken(node.args[0]||'').toLowerCase());}
function websocketOn(block){return block.children.some(n=>isWebsocketHeader(n)&&fieldToken(n.args[0]).toLowerCase()==='upgrade'&&n.args[1]!=='""');}
function includedSettings(block){const result=[];function visit(nodes,stack){for(const node of nodes){if(node.kind!=='directive'||node.name!=='include')continue;for(const path of state.includeLinks[node.id]?.targets||[]){if(stack.includes(path))continue;const file=state.doc.files.find(f=>f.path===path);if(file){for(const child of file.nodes)if(child.kind==='directive'&&child.name!=='include')result.push({node:child,path});visit(file.nodes,[...stack,path]);}}}}visit(block.children,[]);return result;}
function listenerParts(node){const raw=fieldToken(node.args[0]||'80');if(raw.startsWith('unix:'))return null;if(/^\d+$/.test(raw))return {address:'*',port:Number(raw)};let match=raw.match(/^\[([^\]]+)\](?::(\d+))?$/);if(match)return {address:match[1],port:Number(match[2]||80)};match=raw.match(/^(.*):(\d+)$/);return {address:match?match[1]:raw,port:Number(match?match[2]:80)};}
function markBasicDirty(){state.basicDirty=true;$('#changeStatus').textContent='Unapplied basic settings';scheduleAutoCheck();}
function advancedArea(block,managedIds){
  const advanced=block.children.filter(n=>!managedIds.has(n.id)),initial=renderNodes(advanced).trimEnd();
  const source=el('textarea',{class:'advanced-source',spellcheck:'false',rows:Math.max(4,Math.min(initial.split('\n').length+1,12)),value:initial,'aria-label':'Advanced code for '+block.name+' '+block.args.join(' '),placeholder:'# Custom directives and nested blocks go here'});
  const details=el('details',{class:'advanced-area'},el('summary',{text:`Advanced / custom code · ${advanced.length} items`}),el('p',{class:'hint',text:'Everything outside the simple controls at this level lives here. It stays attached when you change the controls. Add custom directives or nested blocks.'}),source);source.addEventListener('input',markBasicDirty);
  for(const node of advanced.filter(n=>n.kind==='directive'&&n.name==='include')){const info=el('div',{class:'include-info','data-include':node.id});renderIncludeInfo(info,node);details.append(info);}
  return {details,source,initial,ids:advanced.map(n=>n.id),blockId:block.id};
}
async function applyAdvancedTo(doc,area){
  if(area.source.value===area.initial)return;
  const {nodes}=await api('/api/parse',{text:area.source.value,path:state.file});
  const file=doc.files.find(f=>f.path===state.file),block=area.blockId==='__file__'?{children:file.nodes}:findIn(file.nodes,area.blockId).node;
  const old=new Set(area.ids),last=block.children.findLastIndex(n=>old.has(n.id)),output=[];let replacement=0;
  block.children.forEach((node,index)=>{if(old.has(node.id)){if(replacement<nodes.length)output.push(nodes[replacement++]);if(index===last)output.push(...nodes.slice(replacement));}else output.push(node);});
  if(last<0)output.push(...nodes);block.children=output;if(area.blockId==='__file__')file.nodes=output;
}
async function applyBasicDraft(){
  if(!state.basicDirty)return true;
  try{let doc=clone(state.doc);for(const form of state.basicForms||[]){const patch=form.patch();if(Object.keys(patch).length)doc=await api('/api/basic',{document:doc,node_id:form.nodeId,patch});await applyAdvancedTo(doc,form.advanced);}for(const area of state.basicRootAreas||[])await applyAdvancedTo(doc,area);doc=await api('/api/document',{document:doc});state.basicDirty=false;mutate(()=>{state.doc=doc;},'Basic settings applied');return true;}catch(error){toast(error.message);return false;}
}
function renderBasicV2(canvas){
  state.basicForms=[];state.basicRootAreas=[];const rootContexts=contextsFor(null);
  canvas.append(el('div',{class:'basic-intro'},el('div',{class:'eyebrow',text:'DOMAINS, DESTINATIONS, AND THE DETAILS'}),el('h2',{text:'Build it your way.'}),el('p',{text:'Use the everyday controls, then open Advanced for everything else. Changes stay attached to the same server and route.'})));
  if(!rootContexts.some(c=>['http','main'].includes(c))){canvas.append(el('p',{class:'hint',text:'Basic supports HTTP hosts. Use Blocks or Nginx for this context.'}));return;}
  const servers=[];function collect(nodes,context){for(const n of nodes)if(n.kind==='block'){if(n.name==='server'&&context==='http')servers.push(n);else collect(n.children,n.name);}}collect(currentFile().nodes,rootContexts.includes('http')?'http':'main');
  for(const server of servers)canvas.append(basicServerCard(server));
  if(!servers.length)canvas.append(el('p',{class:'hint',text:'No HTTP hosts in this file. Choose a starter below, or open an included file.'}));
  const starters=el('div',{class:'basic-starters'});for(const recipe of (state.recipes||[]).filter(r=>['proxy_host','static_host','redirect_host'].includes(r.id)))starters.append(el('button',{onclick:action(()=>addRecipe(recipe))},el('strong',{text:'＋ '+recipe.title}),el('small',{text:recipe.hint})));canvas.append(starters);
  // Files can also contain maps, upstream pools, and custom code outside servers.
  const root={id:'__file__',name:'file',args:[],children:currentFile().nodes};const managed=new Set(servers.map(n=>n.id));
  const httpBlocks=root.children.filter(n=>n.kind==='block'&&n.name==='http');
  for(const block of httpBlocks){managed.add(block.id);const area=advancedArea(block,new Set(servers.map(n=>n.id)));area.details.querySelector('summary').textContent='HTTP-level advanced / custom code';state.basicRootAreas.push(area);canvas.append(area.details);}
  if(root.children.some(n=>!managed.has(n.id))){const area=advancedArea(root,managed);area.details.querySelector('summary').textContent='File-level advanced / custom code';state.basicRootAreas.push(area);canvas.append(area.details);}
  if(state.basicRootAreas.length)canvas.append(el('button',{class:'full-button',onclick:action(applyBasicDraft),text:'Apply advanced changes'}));
}
function basicServerCard(server){
  const managed=new Set(),names=direct(server,'server_name'),certs=direct(server,'ssl_certificate'),keys=direct(server,'ssl_certificate_key'),card=el('section',{class:'basic-card server-card'});
  card.append(el('div',{class:'basic-card-heading'},el('div',{},el('small',{text:'HTTP HOST'}),el('h3',{text:names[0]?.args.join(' ')||'Unnamed host'})),inlineActions(server)));
  const name=basicInput('Domain names',names[0]?.args.join(' ')||'','text','Separate multiple names with spaces.');if(names.length>1)name.input.disabled=true;else names.forEach(n=>managed.add(n.id));card.append(name.wrapper);
  const listenerItems=[],listenerBox=el('div',{class:'listener-list'});card.append(el('div',{class:'basic-section-title',text:'LISTENERS'}),el('p',{class:'field-hint',text:'Where this host accepts traffic. SSL uses the certificate files below.'}),listenerBox);
  function addListener(node=null){
    const parts=node?listenerParts(node):{address:'*',port:80};if(!parts){listenerBox.append(el('p',{class:'hint',text:'UNIX socket listener retained in Advanced.'}));return;}if(node)managed.add(node.id);
    const address=basicInput('Address',parts.address),port=basicInput('Port',parts.port,'number');port.input.min='1';port.input.max='65535';const ssl=basicCheck('SSL / TLS',node?.args.includes('ssl')||false),def=basicCheck('Default host',node?.args.includes('default_server')||node?.args.includes('default')||false),item={node,address,port,ssl,def,removed:false};listenerItems.push(item);
    const row=el('div',{class:'listener-card'},el('div',{class:'form-row'},address.wrapper,port.wrapper),el('div',{class:'listener-options'},ssl.wrapper,def.wrapper,el('button',{class:'tiny danger',onclick:()=>{item.removed=true;row.remove();markBasicDirty();},text:'Remove ×'})));listenerBox.append(row);
  }
  direct(server,'listen').forEach(addListener);card.append(el('button',{class:'tiny add-listener',onclick:()=>{addListener();markBasicDirty();},text:'＋ Add listener'}));
  const legacy=direct(server,'listen').some(n=>n.args.includes('http2')),h2nodes=direct(server,'http2'),http2=basicCheck('HTTP/2',h2nodes.some(n=>n.args[0]==='on')||legacy,'Uses http2 on; for Nginx 1.25.1+.');if(h2nodes.length>1)http2.input.disabled=true;else h2nodes.forEach(n=>managed.add(n.id));card.append(http2.wrapper);
  if(legacy)card.append(el('button',{class:'tiny modernize-button',onclick:action(async()=>{if(!await applyBasicDraft())return;const doc=await api('/api/modernize-http2',{document:state.doc,node_id:server.id});mutate(()=>{state.doc=doc;},'Converted to http2 on;');}),text:'↻ Convert legacy listen http2 now'}));
  const certificate=basicInput('Certificate chain',certs.length===1?fieldToken(certs[0].args[0]):''),key=basicInput('Private key',keys.length===1?fieldToken(keys[0].args[0]):'');certificate.input.placeholder='/etc/letsencrypt/live/example.test/fullchain.pem';key.input.placeholder='/etc/letsencrypt/live/example.test/privkey.pem';
  const tls=el('details',{class:'tls-settings'},el('summary',{text:'◇ Certificate + private key'}),el('p',{class:'hint',text:'Both files belong together. These are paths on the target host, not key contents uploaded here.'}),certificate.wrapper,key.wrapper);if(certs.length>1||keys.length>1){certificate.input.disabled=true;key.input.disabled=true;tls.append(el('p',{class:'hint',text:'Multiple certificate pairs are retained in Advanced.'}));}else [...certs,...keys].forEach(n=>managed.add(n.id));card.append(tls);
  for(const location of server.children.filter(n=>n.kind==='block'&&n.name==='location'))managed.add(location.id);
  const advanced=advancedArea(server,managed);card.append(advanced.details);
  state.basicForms.push({nodeId:server.id,advanced,patch:()=>{
    const patch={};if(name.input.value!==name.initial)patch.names=name.input.value;const listeners=[];let changed=false;
    for(const item of listenerItems){if(item.removed){changed=true;continue;}const value=item.node?{id:item.node.id}:{};if(!item.node||item.address.input.value!==item.address.initial||item.port.input.value!==item.port.initial){value.address=item.address.input.value;value.port=Number(item.port.input.value);changed=true;}if(!item.node||item.ssl.input.checked!==item.ssl.initial){value.ssl=item.ssl.input.checked;changed=true;}if(!item.node||item.def.input.checked!==item.def.initial){value.default=item.def.input.checked;changed=true;}listeners.push(value);}for(const listener of direct(server,'listen').filter(n=>!listenerParts(n)))listeners.push({id:listener.id});if(changed)patch.listeners=listeners;if(http2.input.checked!==http2.initial)patch.http2=http2.input.checked;if(certificate.input.value!==certificate.initial||key.input.value!==key.initial)patch.tls={certificate:certificate.input.value,key:key.input.value};return patch;
  }});
  card.append(el('div',{class:'basic-actions'},el('button',{onclick:action(async()=>{if(!await applyBasicDraft())return;state.mode='blocks';state.selected=server.id;render();}),text:'View as blocks ↗'}),el('button',{class:'primary',onclick:action(applyBasicDraft),text:'Apply host settings'})));
  const routes=el('div',{class:'basic-routes'},el('div',{class:'basic-section-title',text:'ROUTES'}));for(const location of server.children.filter(n=>n.kind==='block'&&n.name==='location'))routes.append(basicLocationCard(location));routes.append(el('button',{class:'add-custom',onclick:action(async()=>{if(!await applyBasicDraft())return;mutate(()=>{locate(server.id).node.children.push(newNode('location',['/new-route/'],'block',[newNode('proxy_pass',['http://127.0.0.1:8080'])]));},'Route added');}),text:'＋ Add route to this host'}));card.append(routes);card.addEventListener('input',markBasicDirty);card.addEventListener('change',markBasicDirty);return card;
}
function basicLocationCard(location){
  const card=el('section',{class:'basic-route'}),managed=new Set();card.append(el('div',{class:'basic-card-heading'},el('strong',{text:location.args.join(' ')}),inlineActions(location)));
  const proxy=direct(location,'proxy_pass'),roots=direct(location,'root'),returns=direct(location,'return'),initialType=proxy.length===1?'proxy':roots.length===1?'static':returns.length===1&&['301','302','303','307','308'].includes(returns[0].args[0])?'redirect':'custom';
  const type=el('select',{'aria-label':'Route type'},['proxy','static','redirect','custom'].map(value=>el('option',{value,text:({proxy:'Reverse proxy',static:'Static files',redirect:'Redirect',custom:'Custom / advanced'})[value]})));type.value=initialType;const path=basicInput('URL match',location.args.join(' '),'text','Prefix /path/, exact = /path, regex ~ pattern, or @name.');card.append(el('div',{class:'form-row'},path.wrapper,el('label',{},'Route type',type)));
  const target=basicInput('Forward destination',proxy[0]?.args.join(' ')||'http://127.0.0.1:8080','text','The trailing slash changes forwarded paths.'),root=basicInput('Website directory',fieldToken(roots[0]?.args[0])||'/var/www/html'),tryFiles=basicInput('File fallback',direct(location,'try_files')[0]?.args.join(' ')||'$uri $uri/ =404'),redirect=basicInput('Redirect destination',fieldToken(returns[0]?.args[1])||'https://example.test$request_uri');
  const included=includedSettings(location),includedWS=included.filter(item=>isWebsocketHeader(item.node)),includedBuffer=included.find(item=>item.node.name==='proxy_buffering');
  const code=el('select',{'aria-label':'Redirect status'},['301','302','303','307','308'].map(v=>el('option',{value:v,text:v})));code.value=returns[0]?.args[0]||'301';
  const websocket=basicCheck('WebSockets',websocketOn(location)||includedWS.some(item=>fieldToken(item.node.args[0]).toLowerCase()==='upgrade'&&item.node.args[1]!=='""'),includedWS.length?'Configured in '+[...new Set(includedWS.map(item=>item.path))].join(', ')+'. Open Advanced below to edit that snippet.':'Sets HTTP/1.1 and connection upgrade headers on this route.');
  const buffering=basicCheck('Buffer upstream responses',includedBuffer?includedBuffer.node.args[0]!=='off':!direct(location,'proxy_buffering').some(n=>n.args[0]==='off'),includedBuffer?'Configured in '+includedBuffer.path+'. Edit the snippet in Advanced below.':'Uses local settings; parent settings can also apply.');
  if(includedWS.length)websocket.input.disabled=true;if(includedBuffer)buffering.input.disabled=true;
  const proxyFields=el('div',{},target.wrapper,websocket.wrapper,buffering.wrapper),staticFields=el('div',{},root.wrapper,tryFiles.wrapper),redirectFields=el('div',{},redirect.wrapper,el('label',{},'Redirect status',code));function showType(){proxyFields.classList.toggle('hidden',type.value!=='proxy');staticFields.classList.toggle('hidden',type.value!=='static');redirectFields.classList.toggle('hidden',type.value!=='redirect');}type.addEventListener('change',()=>{markBasicDirty();showType();});showType();card.append(proxyFields,staticFields,redirectFields);
  const names=initialType==='proxy'?['proxy_pass','proxy_buffering']:initialType==='static'?['root','try_files']:initialType==='redirect'?['return']:[];for(const n of location.children)if((names.includes(n.name)&&direct(location,n.name).length===1)||(initialType==='proxy'&&websocket.initial&&(isWebsocketHeader(n)||(n.name==='proxy_http_version'&&n.args[0]==='1.1'))))managed.add(n.id);
  const advanced=advancedArea(location,managed);card.append(advanced.details,el('p',{class:'field-hint',text:'Changing route type replaces its routing directives. Custom code remains attached.'}));
  state.basicForms.push({nodeId:location.id,advanced,patch:()=>{
    const patch={};if(path.input.value!==path.initial)patch.path=path.input.value;const switched=type.value!==initialType;
    if(switched&&type.value==='custom')throw new Error('Edit routing code in Advanced, or choose a concrete route type.');if(switched)patch.type=type.value;
    if(type.value==='proxy'){if(switched||target.input.value!==target.initial)patch.target=target.input.value;if(switched||websocket.input.checked!==websocket.initial)patch.websockets=websocket.input.checked;if(buffering.input.checked!==buffering.initial)patch.buffering=buffering.input.checked;}
    if(type.value==='static'){if(switched||root.input.value!==root.initial)patch.root=root.input.value;if(switched||tryFiles.input.value!==tryFiles.initial)patch.try_files=tryFiles.input.value;}
    if(type.value==='redirect'&&(switched||redirect.input.value!==redirect.initial||code.value!==(returns[0]?.args[0]||'301')))patch.redirect={target:redirect.input.value,code:code.value};return patch;
  }});card.append(el('button',{class:'full-button',onclick:action(applyBasicDraft),text:'Apply route settings'}));return card;
}
