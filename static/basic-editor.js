/* Basic forms are projections of specific directives, with the rest in Advanced. */
function basicInput(label,value,type='text',hint=''){const input=el('input',{type,value});return {input,wrapper:el('label',{},label,input,hint?el('small',{class:'field-hint',text:hint}):null),initial:String(value??'')};}
function basicCheck(label,value,hint=''){const input=el('input',{type:'checkbox',checked:value});return {input,wrapper:el('label',{class:'basic-checkbox'},input,el('span',{},label,hint?el('small',{text:hint}):null)),initial:!!value};}
function direct(block,name){return block.children.filter(n=>n.kind==='directive'&&n.name===name);}
function fieldToken(token){if(!token)return '';if(token.startsWith('"')&&token.endsWith('"')){try{return JSON.parse(token);}catch{}}if(token.startsWith("'")&&token.endsWith("'"))return token.slice(1,-1);return token;}
function isWebsocketHeader(node){return node.name==='proxy_set_header'&&['upgrade','connection'].includes(fieldToken(node.args[0]||'').toLowerCase());}
function websocketOn(block){return block.children.some(n=>isWebsocketHeader(n)&&fieldToken(n.args[0]).toLowerCase()==='upgrade'&&n.args[1]!=='""');}
function includedSettings(block){const result=[];function visit(nodes,stack){for(const node of nodes){if(node.kind!=='directive'||node.name!=='include')continue;for(const path of state.includeLinks[node.id]?.targets||[]){if(stack.includes(path))continue;const file=state.doc.files.find(f=>f.path===path);if(file){for(const child of file.nodes)if(child.kind==='directive'&&child.name!=='include')result.push({node:child,path});visit(file.nodes,[...stack,path]);}}}}visit(block.children,[]);return result;}
function listenerParts(node){const raw=fieldToken(node.args[0]||'80');if(raw.startsWith('unix:'))return null;if(/^\d+$/.test(raw))return {address:'*',port:Number(raw)};let match=raw.match(/^\[([^\]]+)\](?::(\d+))?$/);if(match)return {address:match[1],port:Number(match[2]||80)};match=raw.match(/^(.*):(\d+)$/);return {address:match?match[1]:raw,port:Number(match?match[2]:80)};}
function markBasicDirty(){state.basicDirty=true;$('#changeStatus').textContent='Unsaved basic settings';scheduleAutoCheck();}
// Comments are kept in Advanced but are not "code": count them apart so a stock file does not read as 25 custom items.
function advancedSummary(advanced){
  const code=advanced.filter(n=>n.kind!=='comment').length,notes=advanced.length-code;
  const parts=[code?`${code} item${code===1?'':'s'}`:'nothing custom'];if(notes)parts.push(`${notes} comment${notes===1?'':'s'}`);
  return 'Advanced / custom code · '+parts.join(' · ');
}
function advancedArea(block,managedIds){
  // A comment written on the same line as a managed directive (or on the block's opening line) stays with it.
  const hasParent=block.id!=='__file__',owned=new Set(managedIds);
  block.children.forEach((n,i)=>{if(isInlineNote(block.children,i,hasParent)&&(i===0||owned.has(block.children[i-1].id)))owned.add(n.id);});
  const advanced=block.children.filter(n=>!owned.has(n.id)),initial=renderNodes(advanced).trimEnd();
  const source=el('textarea',{class:'advanced-source',spellcheck:'false',rows:Math.max(4,Math.min(initial.split('\n').length+1,12)),value:initial,'aria-label':'Advanced code for '+block.name+' '+block.args.join(' '),placeholder:'# Custom directives and nested blocks go here'});
  const details=el('details',{class:'advanced-area'},el('summary',{text:advancedSummary(advanced)}),el('p',{class:'hint',text:'Everything outside the simple controls at this level lives here. It stays attached when you change the controls. Add custom directives or nested blocks.'}),source);source.addEventListener('input',markBasicDirty);
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
// The Basic view itself (cards, switches, routes) lives in basic2.js.
