/* Task-focused controls over the ordered Nginx tree. */
function renderRecipes(box,search){
  const recipes=(state.recipes||[]).filter(r=>(r.title+' '+r.hint).toLowerCase().includes(search));
  if(!recipes.length)return;
  box.append(el('div',{class:'palette-group-title',text:'READY-MADE SECTIONS'}));
  for(const recipe of recipes){prepareRecipe(recipe);box.append(el('button',{class:'recipe-button',title:recipe.hint,'data-recipe':recipe.id,onclick:action(()=>addRecipe(recipe))},el('strong',{text:recipe.title}),el('small',{text:recipe.hint})));}
  box.append(el('div',{class:'palette-group-title',text:'INDIVIDUAL DIRECTIVES'}));
}
// Parses a recipe once so it can be dragged: its blocks are checked against drop zones while dragging.
function prepareRecipe(recipe){if(!recipe.ready)recipe.ready=api('/api/parse',{text:recipe.source}).then(result=>{recipe.parsedNodes=result.nodes;}).catch(()=>{});return recipe.ready;}
function parentFor(nodes){let parent=selectedParent();while(parent){if(nodes.every(n=>canPlace(n,parent)))return parent;parent=locate(parent).parent;}if(nodes.every(n=>canPlace(n,null)))return null;throw new Error('Select a compatible server or location for this section.');}
async function addRecipe(recipe,slot){
  if(!await applyDraft())return;
  const source=recipe.id==='auto_cert'?await autoCertSource(recipe.source,slot?slot.parent:undefined):recipe.source;
  const parsed=await api('/api/parse',{text:source}),parent=slot?slot.parent:parentFor(parsed.nodes);
  if(slot){const blocked=parsed.nodes.find(node=>!canPlace(node,parent));if(blocked)throw new Error(placementMessage(blocked,parent));}
  if(recipe.id==='websockets'&&parent){const included=includedSettings(locate(parent).node).filter(item=>isWebsocketHeader(item.node));if(included.length)throw new Error('WebSocket headers already come from '+[...new Set(included.map(item=>item.path))].join(', ')+'. Open that include to edit them.');const doc=await api('/api/basic',{document:state.doc,node_id:parent,patch:{websockets:true}});mutate(()=>{state.doc=doc;state.selected=parent;},'WebSocket support added');return;}
  if(recipe.id==='tls_pair'&&parent){const cert=locate(parent).node.children.find(n=>n.name==='ssl_certificate');if(cert){await selectNode(cert.id);toast('This server already has certificate files. Edit the pair in Basic or on its TLS section.');return;}}
  mutate(()=>{const target=parent?locate(parent).node.children:currentFile().nodes;const index=slot&&Number.isInteger(slot.index)?slot.index:target.length;target.splice(index,0,...parsed.nodes);state.selected=parsed.nodes[0].id;},recipe.title+' added');
}
function isCustom(node,parent){const context=parent?locate(parent)?.node.name:null;return node.kind!=='comment'&&!state.known.has(node.name)&&!state.tableContexts.has(context);}
function visualGroup(nodes,index,parent){
  const first=nodes[index];
  if(isCustom(first,parent)){const group=[first];let next=index+1;while(next<nodes.length&&isCustom(nodes[next],parent))group.push(nodes[next++]);return {title:'Custom code',kind:'custom',nodes:group};}
  if(['ssl_certificate','ssl_certificate_key'].includes(first.name)){const group=[first];let next=index+1;while(next<nodes.length&&['ssl_certificate','ssl_certificate_key','ssl_trusted_certificate'].includes(nodes[next].name))group.push(nodes[next++]);return {title:'TLS certificate files',kind:'tls',nodes:group};}
  const ws=n=>n.kind==='directive'&&(n.name==='proxy_http_version'||(n.name==='proxy_set_header'&&['upgrade','connection'].includes(n.args[0]?.toLowerCase())));
  if(ws(first)){const group=[first];let next=index+1;while(next<nodes.length&&ws(nodes[next]))group.push(nodes[next++]);if(group.some(n=>n.name==='proxy_set_header'))return {title:'WebSocket connection',kind:'websocket',nodes:group};}
  return null;
}
function groupElement(group,parent){
  const ids=group.nodes.map(n=>n.id),first=group.nodes[0],wrapper=el('section',{class:`code-group group-${group.kind}`,'data-group':first.id});
  const actions=el('span',{class:'section-actions'},el('button',{class:'tiny',title:'Duplicate this section','aria-label':'Duplicate '+group.title,onclick:()=>mutate(()=>{const hit=locate(ids[0]),copies=group.nodes.map(n=>{const copy=clone(n);reidentify(copy);return copy;});hit.nodes.splice(hit.index+group.nodes.length,0,...copies);},'Section duplicated'),text:'⧉'}),el('button',{class:'tiny danger',title:'Remove this section','aria-label':'Delete '+group.title,onclick:()=>mutate(()=>{const hit=locate(ids[0]);hit.nodes.splice(hit.index,group.nodes.length);state.selected=null;},'Section removed · Undo is available'),text:'×'}));
  wrapper.append(el('div',{class:'section-heading'},el('strong',{text:(group.kind==='custom'?'⌘ ':group.kind==='tls'?'◇ ':'⇄ ')+group.title}),actions));
  if(group.kind==='custom'){
    const source=el('textarea',{class:'custom-code-input',spellcheck:'false',rows:Math.min(10,Math.max(3,renderNodes(group.nodes).split('\n').length)),'aria-label':'Custom code in '+contextsFor(parent).join('/'),value:state.customDrafts[first.id]?.text??renderNodes(group.nodes).trimEnd()});
    source.addEventListener('input',()=>{state.customDrafts[first.id]={ids,parent,text:source.value};state.customDraft=state.customDrafts[first.id];$('#changeStatus').textContent='Unapplied custom code';scheduleAutoCheck();});
    wrapper.append(source,el('div',{class:'section-foot'},el('small',{text:'Runs here, in '+contextsFor(parent).join(' / ')}),el('button',{class:'tiny',onclick:action(async()=>{state.customDrafts[first.id]={ids,parent,text:source.value};state.customDraft=state.customDrafts[first.id];await applyCustomDraft();}),text:'Apply code ✓'})));
  }else{
    const contents=el('div',{class:'group-directives'});for(const node of group.nodes)contents.append(el('div',{class:'group-directive-row'},el('span',{text:node.name}),node.args.map((arg,index)=>argumentControl(node,index,arg))));
    wrapper.append(contents,el('p',{class:'group-hint',text:group.kind==='tls'?'These paths refer to files on the host. Enable SSL on a listener to use them.':'HTTP/1.1 and upgrade headers let the application accept WebSocket connections.'}));
  }
  return wrapper;
}
async function applyCustomDraft(){
  const drafts=Object.values(state.customDrafts);if(!drafts.length)return true;
  try{const doc=clone(state.doc);for(const draft of drafts){let hit,file;for(const f of doc.files){hit=findIn(f.nodes,draft.ids[0]);if(hit){file=f;break;}}if(!hit)continue;const parsed=await api('/api/parse',{text:draft.text,path:file.path});if(parsed.nodes.length)parsed.nodes[0].id=draft.ids[0];hit.nodes.splice(hit.index,draft.ids.length,...parsed.nodes);}state.customDrafts={};state.customDraft=null;mutate(()=>{state.doc=doc;state.selected=null;},'Custom code updated');return true;}catch(error){toast(error.message);return false;}
}
function inlineActions(node){return el('span',{class:'section-actions node-inline-actions'},node.kind==='block'?el('button',{class:'tiny',title:'Add inside this block','aria-label':'Add child to '+node.name,onclick:action(async event=>{event.stopPropagation();await selectNode(node.id);$('#paletteSearch').value='';renderPalette();toast('Choose a section or directive from the library.');}),text:'＋'}):null,el('button',{class:'tiny',title:'Duplicate block','aria-label':'Duplicate '+(node.name||'comment'),onclick:action(async event=>{event.stopPropagation();if(!await applyDraft())return;mutate(()=>{const hit=locate(node.id),copy=clone(hit.node);reidentify(copy);hit.nodes.splice(hit.index+1,0,copy);state.selected=copy.id;},'Block duplicated');}),text:'⧉'}),el('button',{class:'tiny danger',title:'Delete block · Undo is available','aria-label':'Delete '+(node.name||'comment'),onclick:action(async event=>{event.stopPropagation();if(!await applyDraft())return;mutate(()=>{const hit=locate(node.id);hit.nodes.splice(hit.index,1);state.selected=null;},'Block removed');}),text:'×'}));}
function renderIncludeInfo(box,node){
  box.replaceChildren();const info=state.includeLinks?.[node.id];if(!info){box.append(el('small',{text:'Resolving included files…'}));return;}
  if(!info.targets.length){box.append(el('span',{text:'File not in this document. '}),el('button',{class:'tiny',onclick:()=>openIncludeImport(node),text:'Import missing file ↥'}));return;}
  for(const path of info.targets){const file=state.doc.files.find(f=>f.path===path);if(!file)continue;const details=el('details',{},el('summary',{text:'▤ '+path+' · '+file.nodes.length+' items'}),el('pre',{text:renderNodes(file.nodes)}));details.append(el('button',{class:'tiny',onclick:action(()=>openFile(path)),text:'Open snippet file ↗'}));box.append(details);}
}
function refreshIncludeInfo(){for(const box of $$('.include-info')){const hit=locate(box.dataset.include);if(hit)renderIncludeInfo(box,hit.node);}}
function openIncludeImport(node){openImportDialog();toast('Add the file this include points to: '+(node.args[0]||'').replace(/^["']|["']$/g,''));}

let autoCheckTimer;
function scheduleAutoCheck(){
  clearTimeout(autoCheckTimer);const version=++state.checkVersion;$('#autoCheckText').textContent='Checking changes…';$('#checkBanner').className='check-banner';
  autoCheckTimer=setTimeout(async()=>{try{
    const payload={document:clone(state.doc)};
    if(state.basicDirty){for(const form of state.basicForms||[]){const patch=form.patch();if(Object.keys(patch).length)payload.document=await api('/api/basic',{document:payload.document,node_id:form.nodeId,patch});await applyAdvancedTo(payload.document,form.advanced);}for(const area of state.basicRootAreas||[])await applyAdvancedTo(payload.document,area);}
    if(state.rawDirty&&state.mode==='raw'){payload.source=$('#sourceEditor').value;payload.path=state.file;}
    for(const draft of [...Object.values(state.customDrafts),state.inspectorDraft])if(draft){const parsed=await api('/api/parse',{text:draft.text,path:state.file});const hit=findIn(payload.document.files.find(f=>f.path===state.file).nodes,draft.ids?.[0]||draft.id);if(hit)hit.nodes.splice(hit.index,draft.ids?.length||1,...parsed.nodes);}
    const report=await api('/api/validate',payload);if(version!==state.checkVersion)return;state.lastCheck=report;showCheckSummary();
  }catch(error){if(version!==state.checkVersion)return;state.lastCheck={structural_ok:false,issues:[{severity:'error',path:state.file,message:error.message}],nginx:{status:'not_run'}};showCheckSummary();}},450);
}
function showCheckSummary(){const issues=state.lastCheck?.issues||[],errors=issues.filter(i=>i.severity==='error'),warnings=issues.filter(i=>i.severity==='warning');$('#autoCheckText').textContent=errors.length?`${errors.length} issue${errors.length===1?'':'s'} to fix · automatic checks`:warnings.length?`${warnings.length} suggestion${warnings.length===1?'':'s'} · automatic checks`:'✓ Automatic checks passed · target-host validation still needed';$('#checkBanner').className='check-banner '+(errors.length?'check-error':warnings.length?'check-warning':'check-ok');$$('.node.has-error').forEach(n=>n.classList.remove('has-error'));for(const error of errors)if(error.node_id)$(`[data-node="${CSS.escape(error.node_id)}"]`)?.classList.add('has-error');}
function showCheckDetails(){const report=state.lastCheck;if(!report)return;const children=[el('p',{class:'hint',text:'Checks run as you edit: structure, common arguments, directive scopes and includes. Full module and certificate validation requires the intended Nginx host.'})];if(!report.issues.length)children.push(el('p',{class:'result-pill',text:'No structural issues found'}));for(const issue of report.issues){const card=el('div',{class:'check-issue'},el('strong',{text:issue.severity==='error'?'Needs fixing':'Suggestion'}),el('p',{text:issue.message}),el('small',{text:issue.path||''}));if(issue.node_id&&locate(issue.node_id))card.append(el('button',{class:'tiny',onclick:action(async()=>{if(!await applyDraft())return;const hit=locate(issue.node_id);state.file=hit.file.path;state.mode='blocks';state.selected=issue.node_id;render();$('#resultDialog').close();}),text:'Show block ↗'}));children.push(card);}result('Automatic checks','FEEDBACK AS YOU EDIT',children);}

/* Pointer dragging keeps snap gaps stable and shares the placement rules. */
function installPointerDragging(){
  let pending=null,active=null,target=null,ghost=null;
  document.addEventListener('pointerdown',event=>{if(event.button!==0||state.mode!=='blocks')return;const palette=event.target.closest('.palette-block'),head=event.target.closest('.node-head'),recipeButton=event.target.closest('.recipe-button');if(!palette&&!head&&!recipeButton)return;if(head&&event.target.closest('input,select,textarea,button'))return;let data;if(recipeButton){const recipe=state.recipes.find(r=>r.id===recipeButton.dataset.recipe);if(!recipe?.parsedNodes)return;data={recipe};}else if(palette){const name=palette.dataset.directive;if(!name)return;data={template:state.palette.find(p=>p.name===name)||{name:'custom_directive',args:['value'],kind:'directive'}};}else data={nodeId:head.closest('.node').dataset.node};pending={data,x:event.clientX,y:event.clientY,label:recipeButton?.querySelector('strong')?.textContent||palette?.textContent||head.querySelector('.node-name')?.textContent||'block'};});
  document.addEventListener('pointermove',event=>{
    if(!pending&&!active)return;if(pending&&Math.hypot(event.clientX-pending.x,event.clientY-pending.y)>5){active=pending;pending=null;startDrag(active.data);ghost=el('div',{class:'drag-ghost',text:active.label});document.body.append(ghost);}if(!active)return;event.preventDefault();ghost.style.left=event.clientX+12+'px';ghost.style.top=event.clientY+12+'px';$$('.drag-over').forEach(z=>z.classList.remove('drag-over'));$$('.receiving').forEach(z=>z.classList.remove('receiving'));const hit=document.elementFromPoint(event.clientX,event.clientY);target=hit?.closest('.drop-zone.snap-valid')||null;
    if(!target&&hit?.closest('#canvas')){let distance=38;for(const zone of $$('.drop-zone.snap-valid')){const r=zone.getBoundingClientRect(),d=Math.abs(event.clientY-r.top-r.height/2);if(event.clientX>=r.left&&event.clientX<=r.right&&d<distance){target=zone;distance=d;}}}
    if(target){target.classList.add('drag-over');const parent=target.dataset.parent;if(parent)$(`[data-node="${CSS.escape(parent)}"] > .node-card`)?.classList.add('receiving');}
    const canvas=$('#canvas'),rect=canvas.getBoundingClientRect();if(event.clientX>rect.left&&event.clientX<rect.right){if(event.clientY>rect.bottom-35)canvas.scrollTop+=12;else if(event.clientY<rect.top+35)canvas.scrollTop-=12;}
  },{passive:false});
  document.addEventListener('pointerup',action(async event=>{if(!active){pending=null;return;}const data=active.data,slot=target?{parent:target.dataset.parent||null,index:Number(target.dataset.index)}:null;active=null;pending=null;target=null;ghost?.remove();endDrag();event.preventDefault();state.suppressClickUntil=Date.now()+250;if(!slot){toast('Drop into a highlighted snap target.');return;}await performDrop(data,slot.parent,slot.index);}));
  document.addEventListener('click',event=>{if(Date.now()<(state.suppressClickUntil||0)){event.preventDefault();event.stopImmediatePropagation();}},true);
  document.addEventListener('pointercancel',()=>{pending=null;active=null;target=null;ghost?.remove();endDrag();});
}
async function performDrop(data,parent,index){if(!await applyDraft())return;if(data.recipe)return addRecipe(data.recipe,{parent,index});if(data.template)return addTemplate(data.template,parent,index);const hit=locate(data.nodeId);if(!hit)return;if(parent===hit.node.id||(parent&&flatten(hit.node.children).some(n=>n.node.id===parent)))throw new Error('A block cannot be moved inside itself.');if(!canPlace(hit.node,parent))throw new Error(placementMessage(hit.node,parent));const target=parent?locate(parent).node.children:currentFile().nodes;let position=index;if(target===hit.nodes&&hit.index<position)position--;mutate(()=>{hit.nodes.splice(hit.index,1);target.splice(position,0,hit.node);state.selected=hit.node.id;},'Block snapped into '+contextsFor(parent).join(' / '));}
