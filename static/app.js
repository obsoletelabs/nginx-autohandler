'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clone = value => structuredClone(value);
// randomUUID only exists on https and localhost; plain http on a LAN address needs the fallback.
const uid = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const state = {doc:null, file:'', mode:'blocks', selected:null, palette:[], known:new Set(), rules:{}, tableContexts:new Set(), scopeInfo:null, dragData:null, history:[], future:[], dirty:false, rawDirty:false, rendered:null, renderVersion:0, revision:0, inspectorDraft:null, argumentDraft:null, argumentPending:null,recipes:[],hints:{},includeLinks:{},customDraft:null,basicDirty:false,basicForms:[],basicRootAreas:[],checkVersion:0,lastCheck:null};
const colors = {Structure:['var(--c-b07843)','var(--c-faf1e5)'],Routing:['var(--c-4b83bd)','var(--c-eff5fc)'],Headers:['var(--c-8b67b7)','var(--c-f5effb)'],Behavior:['var(--c-3b947a)','var(--c-edf7f2)'],TLS:['var(--c-bf778b)','var(--c-fcf1f5)'],Custom:['var(--c-77838e)','var(--c-f0f3f5)']};
state.customDrafts={};
let toastTimer;

function el(tag, attrs={}, ...children) {
  const node = document.createElement(tag);
  for (const [key,value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = value;
    else if (key === 'disabled') node.disabled = value;
    else if (key === 'style') Object.assign(node.style, value);
    else node.setAttribute(key,value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}

async function api(path, payload) {
  const response = await fetchRetry(path, payload === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'nginx-autohandler'},body:JSON.stringify(payload)});
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(errorText(data.error) || `The server answered ${response.status}.`);
  return data;
}
function toast(text,tone) { $('#toast').textContent=text; $('#toast').classList.toggle('warn',tone==='warn'); $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),5000); }
function action(fn) { return async (...args)=> { try { await fn(...args); } catch(error) { reportError(error); } }; }
function currentFile() { return state.doc.files.find(file=>file.path === state.file); }
function flatten(nodes, parent=null, out=[]) { for (const node of nodes) { out.push({node,parent}); flatten(node.children,node.id,out); } return out; }
function locate(id) { for (const file of state.doc.files) { const hit=findIn(file.nodes,id); if(hit) return {...hit,file}; } return null; }
function findIn(nodes,id,parent=null) { for(let index=0;index<nodes.length;index++){ const node=nodes[index]; if(node.id===id) return {node,nodes,index,parent}; const nested=findIn(node.children,id,node.id); if(nested) return nested; } return null; }
function newNode(name,args=[],kind='directive',children=[]) { return {id:uid(),kind,name,args,children,text:'',line:null,end_line:null,inline:false}; }
function textNode(text) { return {...newNode('',[],'comment'),text}; }
// A comment with inline:true sits on the line of the directive or block before it ("listen 443 ssl;  # note"),
// or on the opening line of the block when it is that block's first child. Rows own the note that follows them.
function isInlineNote(nodes,index,hasParent) { const n=nodes[index]; return !!n&&n.kind==='comment'&&n.inline===true&&((index>0&&nodes[index-1].kind!=='comment')||(index===0&&!!hasParent)); }
function noteAfter(nodes,index) { const n=nodes[index+1]; return n&&nodes[index].kind!=='comment'&&n.kind==='comment'&&n.inline===true?n:null; }
function headNote(node) { const c=node.kind==='block'&&node.children[0]; return c&&c.kind==='comment'&&c.inline===true?c:null; }
function spanLength(nodes,index) { return noteAfter(nodes,index)?2:1; }
function removeSpan(nodes,index) { return nodes.splice(index,spanLength(nodes,index)); }
function moveSpan(nodes,index,hasParent,direction) {
  const count=spanLength(nodes,index);let to;
  if(direction<0){let p=index-1;if(p>=0&&isInlineNote(nodes,p,hasParent)){if(p===0)return false;p--;}if(p<0)return false;to=p;}
  else{const next=index+count;if(next>=nodes.length)return false;to=index+spanLength(nodes,next);}
  const moved=nodes.splice(index,count);nodes.splice(to,0,...moved);return true;
}
function renderNodes(nodes,depth=0) {
  const pad='    '.repeat(depth);let out='';
  nodes.forEach((n,i)=>{
    if(n.kind==='comment'){if(i>0&&n.inline===true&&nodes[i-1].kind!=='comment'&&out.endsWith('\n'))out=out.slice(0,-1)+'  '+n.text+'\n';else out+=pad+n.text+'\n';return;}
    const head=pad+[n.name,...n.args].join(' ');
    if(n.kind!=='block'){out+=head+';\n';return;}
    const first=headNote(n);
    out+=head+' {'+(first?'  '+first.text:'')+'\n'+renderNodes(first?n.children.slice(1):n.children,depth+1)+pad+'}\n';
  });
  return out;
}
function groupFor(node) { return state.palette.find(p=>p.name===node.name)?.group || (state.known.has(node.name)?'Behavior':'Custom'); }
function decorate(node,group) { const [color,tint]=colors[group]||colors.Custom; node.style.setProperty('--block',color);node.style.setProperty('--tint',tint); }
function snapshot() { state.history.push(clone(state.doc)); if(state.history.length>70)state.history.shift();state.future=[]; }
function remember() { try { localStorage.setItem('nginx-workshop-draft',JSON.stringify({document:state.doc,dirty:state.dirty})); } catch { /* Disk library remains available if browser storage is full. */ } }
function changed(message) { state.dirty=true;state.rawDirty=false;state.rendered=null;remember();render();if(message)toast(message); }
function mutate(fn,message) { snapshot();fn();changed(message); }
function setDocument(doc,dirty=false) { state.doc=doc;state.revision=doc.revision;chooseStartFile(doc);state.selected=null;state.scopeInfo=null;state.includeLinks={};state.inspectorDraft=null;state.customDraft=null;state.customDrafts={};state.argumentDraft=null;state.basicDirty=false;state.lastCheck=null;state.history=[];state.future=[];state.dirty=dirty;state.rawDirty=false;state.rendered=null;remember();render();afterDocumentLoad(); }
async function allowReplace() { if(state.dirty || state.rawDirty || state.inspectorDraft || state.customDraft || state.basicDirty || state.argumentDraft) return (await ask({title:'Discard unsaved changes?',message:'Changes you have not saved will be lost.',ok:'Discard',danger:true}))===true;return true; }

// The document is named after the folder it was loaded from; that is not a title, so a folder name shows as a friendly one.
function documentTitle(name) {
  const root=($('#configRoot').textContent||'').replace(/[\\/]+$/,'');
  const folder=root.split(/[\\/]/).pop();
  return !name||name===folder||name==='Imported configuration'?'Nginx configuration':name;
}
function render() {
  if(!state.doc)return;
  if(!state.doc.files.some(f=>f.path===state.file))state.file=state.doc.entrypoint;
  if(state.selected&&!locate(state.selected))state.selected=null;
  $('#documentName').value=documentTitle(state.doc.name);$('#documentName').title='Config root: '+($('#configRoot').textContent||'');
  const onDisk=state.diskFiles&&state.diskFiles.size>0;
  $('#savedLabel').textContent=state.dirty?'NOT SAVED':state.savedLabel||(onDisk?'ON DISK':state.doc.revision?`REVISION ${state.doc.revision}`:'NOT SAVED');
  $('#changeStatus').textContent=state.dirty?'Unsaved changes':state.savedStatus||(onDisk||state.doc.revision?'All changes saved':'Example · save to keep');
  $('#fileCount').textContent=`${state.doc.files.length} file${state.doc.files.length===1?'':'s'}`;
  const all=state.doc.files.flatMap(file=>flatten(file.nodes));
  $('#nodeCount').textContent=`${all.filter(n=>n.node.kind!=='comment').length} blocks & directives`;
  $('#contextLabel').textContent=state.doc.context.toUpperCase()+' CONTEXT';
  $('#undoBtn').disabled=!state.history.length;
  $('#redoBtn').disabled=!state.future.length;
  $$('.mode-tabs button').forEach(b=>b.classList.toggle('active',b.dataset.mode===state.mode));
  renderFileList();renderFileHeader();renderPalette();renderCanvas();renderInspector();renderSettings();schedulePreview();scheduleAutoCheck();
}
// renderFileList and renderFileHeader (the file navigator) live in files.js.
function renderPalette() {
  const search=$('#paletteSearch').value.toLowerCase();
  const box=$('#palette');box.replaceChildren();
  renderRecipes(box,search);
  for(const group of Object.keys(colors).filter(g=>g!=='Custom')) {
    const items=state.palette.filter(item=>item.group===group&&item.name.includes(search));
    if(!items.length)continue;
    box.append(el('div',{class:'palette-group-title',text:group.toUpperCase()}));
    for(const item of items) {
      const button=el('button',{class:'palette-block',draggable:'false','data-directive':item.name,title:(state.hints[item.name]||`Add ${item.name}`)+` Contexts: ${item.contexts.join(', ')}`,onclick:action(()=>addTemplate(item))},item.name,el('span',{text:item.kind==='block'?'⊏':'＋'}));
      decorate(button,group);
      const valid=canPlace({...item,children:[]},selectedParent());
      button.classList.toggle('scope-unavailable',!valid);button.setAttribute('aria-disabled',String(!valid));
      if(!valid)button.title=`Select a compatible scope (${item.contexts.join(', ')}), or drag this block to one.`;
      button.addEventListener('dragstart',event=>{event.dataTransfer.setData('application/json',JSON.stringify({template:item}));event.dataTransfer.effectAllowed='copy';startDrag({template:item});});
      button.addEventListener('dragend',endDrag);
      box.append(button);
    }
  }
  const custom=el('button',{class:'palette-block',onclick:action(()=>addCustom()),draggable:'false','data-directive':'custom_directive'},'Custom code',el('span',{text:'＋'}));decorate(custom,'Custom');
  custom.addEventListener('dragstart',event=>{const data={template:{name:'custom_directive',args:['value'],kind:'directive'}};event.dataTransfer.setData('application/json',JSON.stringify(data));startDrag(data);});custom.addEventListener('dragend',endDrag);box.append(custom);
}
function selectedParent(){const hit=state.selected&&locate(state.selected);return hit?(hit.node.kind==='block'?hit.node.id:hit.parent):null;}
function contextsFor(parent){return parent?[locate(parent).node.name]:(state.scopeInfo?.[state.file]||[state.doc.context]);}
function allowed(node,context){if(node.kind==='comment'||state.tableContexts.has(context))return true;if(!['main','http','stream','mail','server','location','upstream','if','limit_except','events'].includes(context))return true;if(node.name==='server'&&node.kind==='directive')return context==='upstream';const rule=state.rules[node.name];return !rule||(node.kind===rule.kind&&(rule.contexts.includes('any')||rule.contexts.includes(context)));}
function canPlace(node,parent){return contextsFor(parent).every(c=>allowed(node,c))&&node.children.every(child=>validSubtree(child,node.name));}
function validSubtree(node,context){return allowed(node,context)&&node.children.every(child=>validSubtree(child,node.name));}
function placementMessage(node,parent){const rule=state.rules[node.name];return `${node.name} cannot snap into ${contextsFor(parent).join(' / ')}. ${rule?'Use '+rule.contexts.join(' or ')+'.':'Check the child blocks.'}`;}
function startDrag(data){
  state.dragData=data;document.body.classList.add('dragging');
  const node=data.template?{...data.template,children:[]}:locate(data.nodeId)?.node;
  $$('.drop-zone').forEach(zone=>{const parent=zone.dataset.parent||null;const cycle=data.nodeId&&(parent===data.nodeId||(parent&&flatten(node.children).some(n=>n.node.id===parent)));const valid=data.recipe?data.recipe.parsedNodes.every(n=>canPlace(n,parent)):node&&!cycle&&canPlace(node,parent);zone.classList.toggle('snap-valid',valid);zone.classList.toggle('snap-invalid',!valid);zone.textContent=valid?'Snap into '+contextsFor(parent).join(' / '):'';});
}
function endDrag(){state.dragData=null;document.body.classList.remove('dragging');$$('.drop-zone').forEach(zone=>{zone.classList.remove('snap-valid','snap-invalid','drag-over');zone.textContent=zone.classList.contains('empty')?'Drop blocks here':'';});$$('.receiving').forEach(node=>node.classList.remove('receiving'));}
async function selectNode(id){if(!await applyArgument()||!await applyInspector())return;state.selected=id;$$('.node.selected').forEach(n=>n.classList.remove('selected'));$(`[data-node="${CSS.escape(id)}"]`)?.classList.add('selected');renderInspector();renderPalette();$('#canvasHint').textContent='New blocks snap into '+contextsFor(selectedParent()).join(' / ');if($('#library').classList.contains('hidden'))showRight('inspector');}
async function addTemplate(template,parent=undefined,index=null) {
  if(!await applyDraft())return;
  if(parent===undefined && state.selected) { const hit=locate(state.selected); parent=hit.node.kind==='block'?hit.node.id:hit.parent; }
  const nodes=parent?locate(parent).node.children:currentFile().nodes;
  const node=newNode(template.name,clone(template.args),template.kind);
  if(!canPlace(node,parent||null))throw new Error(placementMessage(node,parent||null));
  mutate(()=>{nodes.splice(index??nodes.length,0,node);state.selected=node.id;},`Added ${node.name}`);
}
async function addCustom() { await addTemplate({name:'custom_directive',args:['value'],kind:'directive'});showRight('inspector'); }

function dropZone(parent,index,empty=false) {
  const zone=el('div',{class:'drop-zone'+(empty?' empty':''),'data-parent':parent||'','data-index':index,role:'presentation'},empty?'Drop blocks here':null);
  zone.addEventListener('dragover',event=>{event.stopPropagation();if(zone.classList.contains('snap-invalid')){event.dataTransfer.dropEffect='none';return;}event.preventDefault();zone.classList.add('drag-over');if(parent)$(`[data-node="${CSS.escape(parent)}"] > .node-card`)?.classList.add('receiving');});
  zone.addEventListener('dragleave',()=>{zone.classList.remove('drag-over');$$('.receiving').forEach(n=>n.classList.remove('receiving'));});
  zone.addEventListener('drop',action(async event=>{
    event.preventDefault();event.stopPropagation();endDrag();
    const raw=event.dataTransfer.getData('application/json');if(!raw)return;
    const data=JSON.parse(raw);
    if(data.template)return addTemplate(data.template,parent,index);
    const hit=locate(data.nodeId);if(!hit)return;
    if(parent===hit.node.id || (parent&&flatten(hit.node.children).some(n=>n.node.id===parent)))throw new Error('A block cannot be moved inside itself.');
    if(!canPlace(hit.node,parent))throw new Error(placementMessage(hit.node,parent));
    const target=parent?locate(parent).node.children:currentFile().nodes;
    let position=index;const count=spanLength(hit.nodes,hit.index);
    if(target===hit.nodes&&hit.index<position)position-=count;
    mutate(()=>{const moved=hit.nodes.splice(hit.index,count);target.splice(position,0,...moved);state.selected=hit.node.id;},'Block moved');
  }));
  return zone;
}
function blockList(nodes,parent=null) {
  const container=el('div',{class:'node-list'}),hasParent=!!parent;
  if(!nodes.some((n,i)=>!isInlineNote(nodes,i,hasParent))) {container.append(dropZone(parent,nodes.length,true));return container;}
  // Inline comments are shown on the row that owns them, so they have no row (or drop zone) of their own.
  for(let index=0;index<nodes.length;){
    if(isInlineNote(nodes,index,hasParent)){index++;continue;}
    container.append(dropZone(parent,index));const group=visualGroup(nodes,index,parent);
    if(group){container.append(groupElement(group,parent));index+=group.nodes.length;}else{container.append(nodeElement(nodes[index],noteAfter(nodes,index)));index++;}
  }
  container.append(dropZone(parent,nodes.length));return container;
}
// The "# comment" on a row: click to edit, empty text removes it. `after` is the comment node following the row.
function noteEditor(node,comment,anchor,after) {
  const input=el('input',{class:'note-input',value:comment?comment.text.replace(/^#+\s?/,''):'',placeholder:'Comment, e.g. Listen on https','aria-label':'Comment for '+(node.name||'line'),draggable:'false'});
  let done=false;
  const finish=async save=>{
    if(done)return;done=true;
    const text=input.value.replace(/[\r\n]+/g,' ').trim();
    const previous=comment?comment.text.replace(/^#+\s?/,''):'';
    if(!save||text===previous){input.replaceWith(anchor);return;}
    if(!await applyDraft()){input.replaceWith(anchor);return;}
    mutate(()=>{
      const hit=locate(node.id),existing=comment&&locate(comment.id);
      if(existing&&text){existing.node.text=text.startsWith('#')?text:'# '+text;}
      else if(existing){existing.nodes.splice(existing.index,1);}
      else if(text){hit.nodes.splice(hit.index+1,0,{...newNode('',[],'comment'),text:text.startsWith('#')?text:'# '+text,inline:true});}
      state.selected=node.id;
    },text?(comment?'Comment updated':'Comment added'):'Comment removed');
  };
  input.addEventListener('click',event=>event.stopPropagation());
  input.addEventListener('mousedown',event=>event.stopPropagation());
  input.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Enter'){event.preventDefault();finish(true);}if(event.key==='Escape'){event.preventDefault();finish(false);}});
  input.addEventListener('blur',()=>finish(true));
  anchor.replaceWith(input);input.focus();input.select();
}
function noteControls(node,after) {
  const notes=[headNote(node),after].filter(Boolean);
  if(!notes.length){
    const add=el('button',{class:'note-add',type:'button',title:'Add a comment on this line','aria-label':'Add comment to '+node.name,text:'# Add comment'});
    add.addEventListener('click',event=>{event.stopPropagation();noteEditor(node,null,add,after);});return [add];
  }
  return notes.map(comment=>{const chip=el('button',{class:'node-note',type:'button',title:'Edit this comment (clear it to remove)',text:comment.text});chip.addEventListener('click',event=>{event.stopPropagation();noteEditor(node,comment,chip,after);});return chip;});
}
function nodeElement(node,after=null) {
  const group=groupFor(node),custom=!state.known.has(node.name)&&node.kind!=='comment';
  const wrapper=el('article',{class:`node node-${node.kind}${state.selected===node.id?' selected':''}`,'data-node':node.id});decorate(wrapper,group);
  const head=el('div',{class:'node-head',draggable:'false',onclick:action(async event=>{event.stopPropagation();await selectNode(node.id);})});
  head.append(el('span',{class:'node-grip','aria-hidden':'true',text:'⠿'}));
  if(node.kind==='comment')head.append(el('span',{class:'node-args',text:node.text}));
  else {
    head.append(el('span',{class:'node-name',text:node.name}));
    const args=el('span',{class:'node-args'},node.args.map((arg,index)=>argumentControl(node,index,arg)));
    if(!['server','http','stream','mail','events'].includes(node.name))args.append(el('button',{class:'argument-add',title:'Add an argument','aria-label':`Add argument to ${node.name}`,onclick:action(async event=>{event.stopPropagation();if(!await applyDraft())return;mutate(()=>{locate(node.id).node.args.push('""');state.selected=node.id;});}),text:'+'}));
    head.append(args);if(custom)head.append(el('span',{class:'node-badge',text:'CUSTOM'}));else if(node.kind==='block')head.append(el('span',{class:'node-badge',text:'SCOPE'}));
    head.append(...noteControls(node,after));
  }
  head.append(inlineActions(node));
  head.addEventListener('dragstart',event=>{if(event.target.tagName==='INPUT'||event.target.tagName==='SELECT'){event.preventDefault();return;}event.stopPropagation();event.dataTransfer.setData('application/json',JSON.stringify({nodeId:node.id}));event.dataTransfer.effectAllowed='move';startDrag({nodeId:node.id});});
  head.addEventListener('dragend',endDrag);
  const card=el('div',{class:'node-card'},head);
  if(node.name==='include'&&node.kind==='directive'){const info=el('div',{class:'include-info','data-include':node.id});renderIncludeInfo(info,node);card.append(info);}
  if(node.kind==='block')card.append(el('div',{class:'node-children'},blockList(node.children,node.id)));
  wrapper.append(card);return wrapper;
}
function argumentControl(node,index,arg){
  const boolean=arg==='on'||arg==='off';
  const attrs={class:'argument argument-input',value:arg,'aria-label':`${node.name} argument ${index+1}`,title:'Edit directly. Keep Nginx quotes, or type a value; spaces will be quoted.',draggable:'false'};
  const input=boolean?el('select',attrs,['on','off'].map(value=>el('option',{value,text:value}))):el('input',attrs);
  input.value=arg;
  if(!boolean)input.style.width=`calc(${Math.max(4,Math.min(arg.length+2,55))}ch + 6px)`;
  input.addEventListener('click',event=>event.stopPropagation());
  input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();input.blur();}if(event.key==='Escape'){input.value=arg;input.blur();}});
  input.addEventListener('input',()=>{state.argumentDraft={id:node.id,index,value:input.value};$('#changeStatus').textContent='Editing block value';});
  const commit=()=>{if(input.value!==arg&&!state.argumentDraft)state.argumentDraft={id:node.id,index,value:input.value};applyArgument();};
  input.addEventListener('change',commit);input.addEventListener('blur',commit);
  return el('span',{class:'argument-slot'},input,el('button',{class:'argument-remove',title:'Remove this argument','aria-label':`Remove ${node.name} argument ${index+1}`,onclick:action(async event=>{event.stopPropagation();if(!await applyDraft())return;mutate(()=>{locate(node.id).node.args.splice(index,1);},'Argument removed');}),text:'×'}));
}
function applyArgument(){
  if(state.argumentPending)return state.argumentPending;
  const draft=state.argumentDraft;if(!draft)return Promise.resolve(true);
  state.argumentPending=(async()=>{
    try{const hit=locate(draft.id);if(!hit){state.argumentDraft=null;return true;}let token=draft.value||'""';if(!/^["']/.test(token)&&/[\s;{}]/.test(token))token=JSON.stringify(token);const candidate=clone(hit.node);candidate.args[draft.index]=token;await api('/api/document',{document:{...state.doc,files:[{path:'argument-check.conf',nodes:[candidate]}],entrypoint:'argument-check.conf'}});state.argumentDraft=null;mutate(()=>{locate(draft.id).node.args[draft.index]=token;state.selected=draft.id;},'Argument updated');return true;}catch(error){state.argumentDraft=null;toast(error.message);render();return false;}
  })();
  return state.argumentPending.finally(()=>{state.argumentPending=null;});
}
function renderCanvas() {
  const canvas=$('#canvas');canvas.replaceChildren();
  if(state.mode==='blocks') {
    canvas.append(el('div',{class:'scope-label',text:`${state.doc.context.toUpperCase()} / ${state.file}`}));
    canvas.append(blockList(currentFile().nodes));
    canvas.append(el('button',{class:'add-custom',onclick:action(()=>addTemplate({name:'custom_directive',args:['value'],kind:'directive'},null)),text:'＋ Add a custom directive to this scope'}));
    $('#canvasHint').textContent='Edit values on the blocks · drag the grip to a valid snap target';
  } else if(state.mode==='basic') {renderBasicV2(canvas);$('#canvasHint').textContent='Everyday settings as switches and fields · changes go into the draft straight away';}
  else {
    const json=state.mode==='json';
    const wrap=el('div',{class:'raw-wrap'},el('div',{class:'raw-heading'},el('h3',{text:json?'Stored document · read only':'Custom Nginx source'}),json?null:el('button',{class:'primary',id:'applySourceBtn',onclick:action(async()=>{await applyDraft();}),text:'Apply changes'})));
    const textarea=el('textarea',{id:'sourceEditor',class:'raw-editor',spellcheck:'false','aria-label':json?'Document JSON':'Nginx configuration',value:json?JSON.stringify(state.doc,null,2):renderNodes(currentFile().nodes)});
    textarea.readOnly=json;
    textarea.addEventListener('input',()=>{state.rawDirty=true;$('#changeStatus').textContent='Unsaved source changes';scheduleAutoCheck();});
    textarea.addEventListener('keydown',event=>{if(!json&&event.key==='Tab'){event.preventDefault();textarea.setRangeText('    ',textarea.selectionStart,textarea.selectionEnd,'end');state.rawDirty=true;}});
    wrap.append(textarea,el('p',{class:'raw-notice',text:json?'Internal storage format, shown for inspection. Make changes in Basic, Blocks, or Nginx.':'Apply parses this file into blocks. Unsupported directives remain editable in their original scope. Whitespace is formatted on export.'}));canvas.append(wrap);
    $('#canvasHint').textContent='Source changes are parsed before changing views';
  }
}
async function applyDraft() {
  if(!await applyArgument())return false;
  if(!await applyCustomDraft())return false;
  if(!await applyBasicDraft())return false;
  if(!await applyInspector())return false;
  if(!state.rawDirty)return true;
  const source=$('#sourceEditor').value;
  try {
    if(state.mode==='json') {const doc=await api('/api/document',{document:JSON.parse(source)});snapshot();state.doc=doc;state.doc.revision=state.revision;}
    else {const {nodes}=await api('/api/parse',{text:source,path:state.file});snapshot();currentFile().nodes=nodes;}
    state.selected=null;changed('Source applied');return true;
  } catch(error) {toast(error.message);return false;}
}

function renderInspector() {
  const box=$('#inspector');box.replaceChildren();
  const hit=state.selected&&locate(state.selected);
  if(!hit) {
    box.append(el('div',{class:'empty-inspector'},el('div',{class:'empty-icon',text:'⌖'}),el('h3',{text:'Every directive has a place.'}),el('p',{class:'hint',text:'Select a block to edit its Nginx source, move it, or add children. Unknown directives stay visible as custom blocks.'}),el('div',{class:'metadata-list'},el('div',{},'Current file ',el('span',{text:state.file})),el('div',{},'Entry context ',el('span',{text:state.doc.context})),el('div',{},'nginx reads it ',el('span',{text:/\.disabled$/.test(state.file)?'no, it is switched off':'yes'}))),el('hr',{class:'inspector-divider'}),el('p',{class:'hint',text:'Need a starting point? Add a server block, then add listen, server_name and a location inside it.'})));return;
  }
  const node=hit.node,custom=!state.known.has(node.name)&&node.kind!=='comment';
  box.append(el('div',{class:'selection-type',text:node.kind==='comment'?'Comment':custom?'Custom directive':node.kind==='block'?'Configuration block':'Nginx directive'}),el('h2',{class:'inspector-title',text:node.name||'comment'}),el('span',{class:'type-tag',text:custom?'PRESERVED AS CUSTOM':groupFor(node).toUpperCase()}));
  box.append(el('p',{class:'hint',text:custom?'This directive is outside the starter palette. Its arguments and scope are preserved; edit it directly below.':'Edit the source for this selection. Use Nginx quoting for spaces, empty values, and regular expressions.'}));
  if(state.hints[node.name])box.append(el('p',{class:'block-explanation',text:state.hints[node.name]}));
  if(node.name==='include'){const info=el('div',{class:'include-info','data-include':node.id});renderIncludeInfo(info,node);box.append(info);}
  if(node.name==='listen'&&node.args.includes('http2'))box.append(el('button',{class:'full-button',onclick:action(async()=>{let server=hit;while(server&&server.node.name!=='server')server=server.parent?locate(server.parent):null;if(!server)throw new Error('No parent HTTP server found.');const doc=await api('/api/modernize-http2',{document:state.doc,node_id:server.node.id});mutate(()=>{state.doc=doc;},'Converted legacy listen http2');}),text:'Convert to http2 on; ↗'}));
  const source=el('textarea',{id:'nodeSource',class:'inspector-source',rows:node.kind==='block'?11:5,spellcheck:'false',value:state.inspectorDraft?.id===node.id?state.inspectorDraft.text:renderNodes([node]).trimEnd(),'aria-label':'Selected block source'});
  source.addEventListener('input',()=>{state.inspectorDraft={id:node.id,text:source.value};$('#changeStatus').textContent='Unsaved block changes';scheduleAutoCheck();});
  box.append(el('label',{},'BLOCK SOURCE',source));
  box.append(el('button',{class:'primary full-button',onclick:action(async()=>{state.inspectorDraft={id:node.id,text:source.value};await applyInspector();}),text:'Apply block changes'}));
  box.append(el('div',{class:'node-actions'},el('button',{title:'Move up',disabled:hit.index===0||(hit.index===1&&isInlineNote(hit.nodes,0,!!hit.parent)),onclick:()=>mutate(()=>{moveSpan(hit.nodes,hit.index,!!hit.parent,-1);}),text:'↑ Up'}),el('button',{title:'Move down',disabled:hit.index+spanLength(hit.nodes,hit.index)>=hit.nodes.length,onclick:()=>mutate(()=>{moveSpan(hit.nodes,hit.index,!!hit.parent,1);}),text:'↓ Down'}),el('button',{onclick:()=>mutate(()=>{const copies=hit.nodes.slice(hit.index,hit.index+spanLength(hit.nodes,hit.index)).map(n=>{const c=clone(n);reidentify(c);return c;});hit.nodes.splice(hit.index+copies.length,0,...copies);state.selected=copies[0].id;},'Block duplicated'),text:'Duplicate'})));
  if(node.kind==='block')box.append(el('button',{class:'full-button',onclick:action(addCustom),text:'＋ Add custom child'}));
  box.append(el('hr',{class:'inspector-divider'}),el('div',{class:'metadata-list'},el('div',{},'Scope ',el('span',{text:hit.parent?locate(hit.parent).node.name:state.doc.context})),el('div',{},'Source ',el('span',{text:hit.file.path+(node.line?`:${node.line}`:'')}))),el('button',{class:'danger full-button',onclick:()=>mutate(()=>{removeSpan(hit.nodes,hit.index);state.selected=null;},'Block removed'),text:node.kind==='block'?'Delete block and children':'Delete directive'}));
}
async function applyInspector(){
  const draft=state.inspectorDraft;if(!draft)return true;
  try{const hit=locate(draft.id);if(!hit){state.inspectorDraft=null;return true;}const {nodes}=await api('/api/parse',{text:draft.text,path:hit.file.path});if(!nodes.length)throw new Error('Use Delete to remove this block.');for(const node of nodes)if(!canPlace(node,hit.parent))throw new Error(placementMessage(node,hit.parent));if(nodes.length===1)nodes[0].id=draft.id;state.inspectorDraft=null;mutate(()=>{hit.nodes.splice(hit.index,1,...nodes);state.selected=nodes[0].id;},'Block updated');return true;}catch(error){toast(error.message);return false;}
}
function reidentify(node) {node.id=uid();node.line=null;node.children.forEach(reidentify);}

function renderSettings() {
  const box=$('#settings');box.replaceChildren();
  const enabled=el('input',{type:'checkbox',checked:state.doc.enabled,onchange:()=>mutate(()=>{state.doc.enabled=enabled.checked;})});
  box.append(el('div',{class:'selection-type',text:'Document metadata'}),el('h3',{text:'Delivery intent'}),el('label',{class:'check-label'},enabled,el('span',{text:'Enabled on target hosts'})),el('p',{class:'hint',text:'Disabled configurations are still generated, exported and validated. This flag records deployment intent for future host integration.'}));
  const context=el('select',{'aria-label':'Initial context'},['main','http','stream','mail','server','location'].map(c=>el('option',{value:c,text:c})));context.value=state.doc.context;
  const entry=el('select',{'aria-label':'Entrypoint'},state.doc.files.map(f=>el('option',{value:f.path,text:f.path})));entry.value=state.doc.entrypoint;
  const prefix=el('input',{value:state.doc.prefix,'aria-label':'Nginx configuration prefix'});
  box.append(el('hr',{class:'inspector-divider'}),el('label',{},'Initial Nginx context',context),el('label',{},'Entrypoint file',entry),el('label',{},'Nginx config prefix',prefix),el('button',{class:'full-button',onclick:action(async()=>{
    const candidate=clone(state.doc);candidate.context=context.value;candidate.entrypoint=entry.value;candidate.prefix=prefix.value;await api('/api/document',{document:candidate});mutate(()=>{state.doc=candidate;},'Document settings updated');
  }),text:'Apply document settings'}),el('div',{class:'settings-warning',text:'The prefix resolves relative include paths. Upload included files to resolve them. Missing includes block effective exports and nginx -t.'}),el('p',{class:'hint',text:'Export preserves file paths and include directives. It writes a separate output bundle; deployment and reload are outside this demo.'}));
}

let previewTimer;
function schedulePreview() {clearTimeout(previewTimer);const version=++state.renderVersion;previewTimer=setTimeout(async()=>{try{const data=await api('/api/render',{document:state.doc});if(version!==state.renderVersion)return;const graphChanged=JSON.stringify(state.includeLinks)!==JSON.stringify(data.includes||{});state.rendered=data;state.scopeInfo=data.file_contexts;state.includeLinks=data.includes||{};if(graphChanged&&state.mode==='basic'&&!state.basicDirty&&!$('#canvas').contains(document.activeElement))renderCanvas();renderPalette();renderPreview();refreshIncludeInfo();$('#contextLabel').textContent=contextsFor(null).join(' / ').toUpperCase()+' CONTEXT';}catch(error){if(version===state.renderVersion)toast(error.message);}},120);}
function renderPreview() {if(!state.rendered)return;const effective=$('#previewType').value==='effective';$('#codePreview').textContent=effective?state.rendered.effective:state.rendered.files[state.file];$('#includeWarning').textContent=effective&&state.rendered.include_issues.length?'Incomplete effective view: '+state.rendered.include_issues.map(i=>i.message).join('; '):effective?'Includes expanded in place. File boundaries remain in the document.':'Generated directly from this file’s ordered blocks.';}
function showRight(which) {$$('.right-tabs button').forEach(b=>b.classList.toggle('active',b.dataset.right===which));['inspector','preview','library','settings'].forEach(id=>$('#'+id).classList.toggle('hidden',id!==which));if(which==='preview')renderPreview();}
function undo(redo=false) {if(state.rawDirty||state.inspectorDraft){toast('Apply source changes before using history.');return;}const from=redo?state.future:state.history,to=redo?state.history:state.future;if(!from.length)return;to.push(clone(state.doc));state.doc=from.pop();state.doc.revision=state.revision;state.selected=null;changed(redo?'Redone':'Undone');}

async function saveDraft() {if(!await applyDraft())return;state.doc.revision=state.revision;const saved=await api('/api/library',{document:state.doc});state.doc=saved;state.revision=saved.revision;state.dirty=false;remember();render();toast(`Saved revision ${saved.revision}`);}
async function refreshLibrary() {const items=await api('/api/library');$('#libraryCount').textContent=items.length;const box=$('#libraryList');box.replaceChildren();if(!items.length)box.append(el('p',{class:'library-empty',text:'Your saved configurations will appear here.'}));for(const item of items)box.append(el('div',{class:'library-item'},el('div',{},el('strong',{text:item.name}),el('small',{text:`${item.files} files · revision ${item.revision} · ${item.enabled?'enabled':'disabled'}`})),el('button',{onclick:action(async()=>{if(!await allowReplace())return;setDocument(await api('/api/library/'+item.id));$('#libraryDialog').close();toast('Configuration loaded');}),text:'Open'})));}
function result(title,eyebrow,children) {$('#resultTitle').textContent=title;$('#resultEyebrow').textContent=eyebrow;$('#resultBody').replaceChildren(...children);$('#resultDialog').showModal();}
async function runValidation() {
  if(!await applyDraft())return;
  const button=$('#validateBtn');button.disabled=true;button.textContent='Checking…';
  try {
    const report=await api('/api/validate',{document:state.doc,nginx:true});
    const passed=report.nginx.status==='passed',structural=report.structural_ok;
    $('#validationStatus').textContent=passed?'nginx -t passed':structural?'Structural checks passed · host check '+report.nginx.status:'Configuration needs attention';
    const contents=[el('div',{class:'result-pill'+(passed?'':' warn'),text:passed?'NGINX VALIDATED':structural?'STRUCTURE CHECKED':'CHECKS NEED ATTENTION'}),el('p',{class:'result-message',text:`Document structure: ${structural?'passed':'issues found'}\nNginx test: ${report.nginx.status}`}),el('pre',{class:'result-code',text:report.nginx.message})];
    for(const issue of report.issues)contents.push(el('p',{class:'form-error',text:`${issue.path||''}: ${issue.message}`}));
    contents.push(el('p',{class:'hint',text:'Certificate paths, installed modules, and inherited settings must also be checked on the intended host.'}));
    result('Validation report','CHECK BEFORE DELIVERY',contents);
  } finally {button.disabled=false;button.textContent='✓ Validate';}
}
async function exportFiles(flatten=false) {
  if(!await applyDraft())return;
  const output=await api('/api/export',{document:state.doc,flatten});
  const link=el('a',{href:output.download,download:'nginx-configuration.zip',text:'Download configuration ZIP ↗'});link.className='download-link';
  result('Configuration exported','WRITTEN TO A SEPARATE BUNDLE',[el('p',{class:'result-message',text:`${output.files.length} Nginx files written. Enabled metadata: ${state.doc.enabled}.`}),el('pre',{class:'result-code',text:output.directory}),link,el('p',{class:'hint',text:'The ZIP includes the versioned JSON document. Original include paths are preserved; place files at their intended paths when deploying.'}),el('button',{class:'full-button',onclick:action(async()=>{$('#resultDialog').close();await exportFiles(true);}),text:'Export a flattened effective.conf instead'})]);
  toast('Export written');
}

$('#documentName').addEventListener('change',action(async()=>{const name=$('#documentName').value.trim();if(!name){$('#documentName').value=documentTitle(state.doc.name);return;}if(!await applyDraft())return;mutate(()=>{state.doc.name=name;});}));
$('#paletteSearch').addEventListener('input',renderPalette);
$$('.mode-tabs button').forEach(button=>button.addEventListener('click',action(()=>setMode(button.dataset.mode,true))));
$$('.right-tabs button').forEach(button=>button.addEventListener('click',()=>showRight(button.dataset.right)));
$$('[data-close]').forEach(button=>button.addEventListener('click',()=>$('#'+button.dataset.close).close()));
$('#undoBtn').addEventListener('click',()=>undo());$('#redoBtn').addEventListener('click',()=>undo(true));
$('#saveBtn').addEventListener('click',action(()=>applyWorkspace()));$('#validateBtn').addEventListener('click',action(runValidation));
$('#previewType').addEventListener('change',renderPreview);$('#copyBtn').addEventListener('click',action(async()=>{await copyText($('#codePreview').textContent);}));


$('#newBtn').addEventListener('click',action(async()=>{
  if(!await allowReplace())return;
  setDocument(await api('/api/workspace'));toast('Reloaded from disk');
}));
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();action(applyWorkspace)();}if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){event.preventDefault();undo(event.shiftKey);}});
window.addEventListener('beforeunload',event=>{if(state.dirty||state.rawDirty||state.inspectorDraft||state.argumentDraft||state.customDraft||state.basicDirty){event.preventDefault();event.returnValue='';}});
$('#checkDetails').addEventListener('click',showCheckDetails);
installPointerDragging();

(async()=>{
  try {
    // files.js (remembered views and last file) runs after this script; wait for it and the saved preferences.
    while(typeof prefsReady==='undefined')await new Promise(done=>setTimeout(done,20));
    await prefsReady;
    const settings=await api('/api/palette');state.palette=settings.palette;state.known=new Set(settings.known);state.rules=settings.rules||{};state.tableContexts=new Set(settings.table_contexts||[]);state.recipes=settings.recipes||[];state.hints=settings.hints||{};
    let restored=false;
    try {const draft=JSON.parse(null);if(draft?.document){setDocument(await api('/api/document',{document:draft.document}),draft.dirty);restored=true;}}catch{/* Start with the example if a browser draft is invalid. */}
    if(!restored)setDocument(await api('/api/workspace'));
    
  }catch(error){$('#canvas').replaceChildren(el('div',{class:'error-banner',text:'Could not connect to the local document engine: '+error.message}));}
})();
