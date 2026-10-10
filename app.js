(function(){
  "use strict";
  const LEGACY_KEY="gtd-taskmanager-v1",DATABASE_NAME="gtd-taskmanager",STORE_NAME="app-data",WORKSPACE_KEY="board",MAX_IMAGE_BYTES=1024*1024;
  const IMAGE_MIME_TYPES=new Set(["image/png","image/jpeg","image/webp"]),EMBEDDED_IMAGE_MIME_TYPES=new Set([...IMAGE_MIME_TYPES,"image/gif","image/avif","image/apng"]);
  const newId=prefix=>prefix+Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-3);
  const starter=()=>({columns:[{id:"inbox",name:"Eingang"},{id:"next",name:"Als Nächstes"},{id:"doing",name:"In Arbeit"},{id:"done",name:"Erledigt"}],tasks:[],labels:[]});
  const createWorkspace=(data=starter())=>({activeBoardId:"board-default",boards:[{id:"board-default",name:"Aufgaben",data}]});
  let workspace=createWorkspace(),state=workspace.boards[0].data,draggedTask=null,draggedColumn=null,toastTimer=0,databasePromise=null,persistenceQueue=Promise.resolve(),persistenceHealthy=true,storageWarningShown=false,boardChannel=null;
  const $=id=>document.getElementById(id),boardEl=$("board");
  function openDatabase(){
    if(databasePromise)return databasePromise;
    databasePromise=new Promise((resolve,reject)=>{
      if(!window.indexedDB){reject(new Error("IndexedDB wird von diesem Browser nicht unterstützt."));return;}
      const request=window.indexedDB.open(DATABASE_NAME,1);
      request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE_NAME))db.createObjectStore(STORE_NAME);};
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();resolve(db);};
      request.onerror=()=>reject(request.error||new Error("Die IndexedDB konnte nicht geöffnet werden."));
    });
    return databasePromise;
  }
  async function readStoredWorkspace(){
    const db=await openDatabase();
    return new Promise((resolve,reject)=>{
      let value;
      const transaction=db.transaction(STORE_NAME,"readonly"),request=transaction.objectStore(STORE_NAME).get(WORKSPACE_KEY);
      request.onsuccess=()=>{value=request.result;};
      transaction.oncomplete=()=>resolve(value);
      transaction.onerror=()=>reject(transaction.error||request.error||new Error("Die Boarddaten konnten nicht gelesen werden."));
      transaction.onabort=()=>reject(transaction.error||new Error("Das Lesen der Boarddaten wurde abgebrochen."));
    });
  }
  async function writeStoredWorkspace(value){
    const db=await openDatabase(),snapshot=cloneBoard(value);
    return new Promise((resolve,reject)=>{
      const transaction=db.transaction(STORE_NAME,"readwrite");
      transaction.objectStore(STORE_NAME).put(snapshot,WORKSPACE_KEY);
      transaction.oncomplete=()=>resolve();
      transaction.onerror=()=>reject(transaction.error||new Error("Die Boarddaten konnten nicht gespeichert werden."));
      transaction.onabort=()=>reject(transaction.error||new Error("Das Speichern der Boarddaten wurde abgebrochen."));
    });
  }
  function cloneBoard(value){return JSON.parse(JSON.stringify(value));}
  function validateEmbeddedImageSizes(markdown){
    const pattern=/data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]*={0,2})/gi;let match;
    while((match=pattern.exec(markdown))){
      const mime=match[1].toLowerCase(),payload=match[2],padding=payload.endsWith("==")?2:payload.endsWith("=")?1:0;
      if(!EMBEDDED_IMAGE_MIME_TYPES.has(mime))throw new Error("Dieses eingebettete Bildformat wird nicht unterstützt.");
      if(!payload||payload.length%4!==0||!/^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(payload))throw new Error("Ein eingebettetes Bild ist beschädigt.");
      if(payload.length/4*3-padding>MAX_IMAGE_BYTES)throw new Error("Jedes Bild darf höchstens 1 MB groß sein.");
    }
  }
  function readLegacyBoard(){try{const saved=JSON.parse(localStorage.getItem(LEGACY_KEY)||"null");return saved?normalizeBackup(saved).data:null;}catch(e){return null;}}
  const THEME_KEY="gtd-taskmanager-theme-v1";
  function applyTheme(theme){
    const dark=theme==="dark";
    document.body.dataset.theme=dark?"dark":"light";
    const button=$("themeToggle");
    button.innerHTML=dark?'<svg aria-hidden="true"><use href="#i-sun"/></svg>':'<svg aria-hidden="true"><use href="#i-moon"/></svg>';
    const label=dark?"Helles Design aktivieren":"Dunkles Design aktivieren";
    button.setAttribute("aria-label",label);button.title=label;button.setAttribute("aria-pressed",String(dark));
    try{localStorage.setItem(THEME_KEY,dark?"dark":"light");}catch(e){}
    const meta=document.querySelector('meta[name="theme-color"]');
    if(meta)meta.content=dark?"#141218":"#f7f5fa";
  }
  let initialTheme="light";
  try{initialTheme=localStorage.getItem(THEME_KEY)==="dark"?"dark":"light";}catch(e){}
  applyTheme(initialTheme);
  const DISPLAY_SIZE_KEY="gtd-taskmanager-display-size-v1";
  function applyDisplaySize(size){
    const small=size==="small";
    document.documentElement.dataset.displaySize=small?"small":"large";
    const button=$("sizeToggle"),label=small?"Große Darstellung aktivieren":"Kleine Darstellung aktivieren (Schrift 30 % kleiner)";
    button.setAttribute("aria-label",label);button.title=label;button.setAttribute("aria-pressed",String(small));
    try{localStorage.setItem(DISPLAY_SIZE_KEY,small?"small":"large");}catch(e){}
  }
  let initialDisplaySize="large";
  try{initialDisplaySize=localStorage.getItem(DISPLAY_SIZE_KEY)==="small"?"small":"large";}catch(e){}
  applyDisplaySize(initialDisplaySize);
  const dateToday=()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");};
  const esc=value=>String(value==null?"":value).replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const safeColor=value=>/^#[0-9a-f]{6}$/i.test(value||"")?value:"#6750a4";
  function labelTextColor(color){
    const channels=safeColor(color).slice(1).match(/../g).map(value=>parseInt(value,16)/255).map(value=>value<=0.04045?value/12.92:Math.pow((value+0.055)/1.055,2.4));
    const luminance=0.2126*channels[0]+0.7152*channels[1]+0.0722*channels[2];
    return luminance>0.179?"#000000":"#ffffff";
  }
  const labelStyle=color=>{const fill=safeColor(color);return "--chip-color:"+fill+";--chip-text:"+labelTextColor(fill);};
  function useWorkspace(value,preferredBoardId){
    workspace=value;
    const active=workspace.boards.find(board=>board.id===(preferredBoardId||workspace.activeBoardId))||workspace.boards[0];
    workspace.activeBoardId=active.id;state=active.data;
  }
  function save(){
    const snapshot=cloneBoard(workspace);
    persistenceQueue=persistenceQueue.catch(()=>false).then(()=>writeStoredWorkspace(snapshot)).then(()=>{persistenceHealthy=true;storageWarningShown=false;publishWorkspace(snapshot);return true;}).catch(()=>{persistenceHealthy=false;if(!storageWarningShown){showToast("IndexedDB konnte nicht speichern. Prüfe die Browsereinstellungen oder den verfügbaren Speicherplatz.");storageWarningShown=true;}return false;});
    return persistenceQueue;
  }
  function normalizeBackup(raw){
    let source=raw,version;
    if(raw&&raw.format){if(raw.format!=="gtd-taskmanager-backup"||![1,2].includes(raw.version))throw new Error("Dieses Backup-Format wird nicht unterstützt.");source=raw.data;version=raw.version;}
    if(version===1||(!version&&(!source||typeof source!=="object"||!Object.prototype.hasOwnProperty.call(source,"boards")))){
      const normalized=normalizeBoardData(source);
      return{data:createWorkspace(normalized.data),shortenedLabels:normalized.shortenedLabels};
    }
    if(!source||!Array.isArray(source.boards)||!source.boards.length)throw new Error("Die Datei enthält keine gültigen Boards.");
    const ids=new Set();let shortenedLabels=false;
    const boards=source.boards.map(board=>{
      if(!board||typeof board.id!=="string"||!board.id||ids.has(board.id)||typeof board.name!=="string"||!board.name.trim())throw new Error("Das Backup enthält ungültige Boards.");
      ids.add(board.id);
      const normalized=normalizeBoardData(board.data);shortenedLabels=shortenedLabels||normalized.shortenedLabels;
      return{id:board.id,name:board.name.trim(),data:normalized.data};
    });
    return{data:{boards,activeBoardId:ids.has(source.activeBoardId)?source.activeBoardId:boards[0].id},shortenedLabels};
  }
  function normalizeBoardData(source){
    if(!source||!Array.isArray(source.columns)||!source.columns.length||!Array.isArray(source.tasks)||!Array.isArray(source.labels))throw new Error("Die Datei enthält kein gültiges Board-Backup.");
    const uniqueItems=(items,type,check)=>{const ids=new Set();return items.map(item=>{if(!item||typeof item.id!=="string"||!item.id||ids.has(item.id)||!check(item))throw new Error("Das Backup enthält ungültige "+type+".");ids.add(item.id);return item;});};
    const columns=uniqueItems(source.columns,"Spalten",item=>typeof item.name==="string"&&item.name.trim()).map(item=>({id:item.id,name:item.name.trim()}));
    const labels=uniqueItems(source.labels,"Labels",item=>typeof item.name==="string"&&item.name.trim()).map(item=>({id:item.id,name:item.name.trim(),color:safeColor(item.color)}));
    const columnIds=new Set(columns.map(item=>item.id)),labelIds=new Set(labels.map(item=>item.id));let shortenedLabels=false;
    const tasks=uniqueItems(source.tasks,"Tasks",item=>typeof item.title==="string"&&item.title.trim()&&typeof item.columnId==="string"&&columnIds.has(item.columnId)).map((item,index)=>{
      if(item.dueDate!=null&&typeof item.dueDate!=="string")throw new Error("Das Backup enthält ein ungültiges Fälligkeitsdatum.");
      if(item.description!=null&&typeof item.description!=="string")throw new Error("Das Backup enthält eine ungültige Beschreibung.");
      validateEmbeddedImageSizes(item.description||"");
      if(item.labelIds!=null&&!Array.isArray(item.labelIds))throw new Error("Das Backup enthält ungültige Task-Labels.");
      const selected=[...new Set(item.labelIds||[])];if(selected.some(id=>typeof id!=="string"||!labelIds.has(id)))throw new Error("Ein Task verweist auf ein nicht vorhandenes Label.");if(selected.length>2)shortenedLabels=true;
      return{id:item.id,title:item.title.trim(),createdAt:typeof item.createdAt==="string"?item.createdAt:new Date().toISOString(),dueDate:item.dueDate||"",description:item.description||"",labelIds:selected.slice(0,2),columnId:item.columnId,order:Number.isFinite(item.order)?item.order:index};
    });
    columns.forEach(column=>tasks.filter(task=>task.columnId===column.id).sort((a,b)=>a.order-b.order).forEach((task,index)=>task.order=index));
    return{data:{columns,tasks,labels},shortenedLabels};
  }
  function showToast(message){const node=$("toast");node.textContent=message;node.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.classList.remove("show"),2600);}
  async function initializeStorage(){
    let loaded=false;
    try{
      const stored=await readStoredWorkspace();
      useWorkspace(stored?normalizeBackup(stored).data:readLegacyBoard()||createWorkspace());loaded=true;
      if(!stored||!Array.isArray(stored.boards))await writeStoredWorkspace(workspace);
      try{localStorage.removeItem(LEGACY_KEY);}catch(e){}
      persistenceHealthy=true;
    }catch(error){
      if(!loaded)useWorkspace(readLegacyBoard()||createWorkspace());persistenceHealthy=false;
      showToast("IndexedDB konnte nicht geladen werden. Änderungen werden möglicherweise nicht dauerhaft gespeichert.");
    }finally{
      render();document.body.dataset.storageLoading="false";
    }
  }
  function prettyDate(value){if(!value)return "";let d;if(value.includes("T"))d=new Date(value);else{const p=value.split("-").map(Number);d=new Date(p[0],p[1]-1,p[2]);}return new Intl.DateTimeFormat("de-DE",{day:"numeric",month:"short"}).format(d);}
  function labelById(id){return state.labels.find(label=>label.id===id);}
  function tasksIn(columnId){return state.tasks.filter(task=>task.columnId===columnId).sort((a,b)=>(a.order||0)-(b.order||0));}
  function plainDescription(markdown){return String(markdown||"").replace(/!\[([^\]]*)\]\((?:\\[\\()]|[^)])+\)/g,"$1").replace(/\[([^\]]+)\]\((?:\\[\\()]|[^)])+\)/g,"$1").replace(/[#*_~>]/g,"").replace(/\s+/g," ").trim();}
  function inlineMarkdown(input){
    let text=esc(input).replace(/\0/g,"\uFFFD"),tick=String.fromCharCode(96);
    const fragments=[],protect=html=>"\u0000"+(fragments.push(html)-1)+"\u0000";
    const emphasis=value=>value.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/__(.+?)__/g,"<strong>$1</strong>").replace(/\*(.+?)\*/g,"<em>$1</em>").replace(/_(.+?)_/g,"<em>$1</em>");
    const unescapeUrl=url=>url.replace(/\\([\\()])/g,"$1");
    text=text.replace(new RegExp(tick+"([^"+tick+"]+)"+tick,"g"),(match,code)=>protect("<code>"+code+"</code>"));
    text=text.replace(/!\[([^\]]*)\]\(((?:https?:\/\/|file:\/\/\/)(?:\\[\\()]|[^)\s])+|data:image\/(?:png|jpeg|webp|gif|avif|apng);base64,[a-z0-9+/]+={0,2})\)/gi,(match,alt,url)=>protect('<img src="'+unescapeUrl(url)+'" alt="'+alt+'" loading="lazy">'));
    text=text.replace(/\[([^\]]+)\]\((https?:\/\/(?:\\[\\()]|[^)\s])+)\)/gi,(match,title,url)=>protect('<a href="'+unescapeUrl(url)+'" target="_blank" rel="noopener noreferrer">'+emphasis(title)+"</a>"));
    return emphasis(text).replace(/\u0000(\d+)\u0000/g,(match,index)=>fragments[Number(index)]);
  }
  function linkifyHtml(html){
    const template=document.createElement("template");template.innerHTML=html;
    const walker=document.createTreeWalker(template.content,NodeFilter.SHOW_TEXT),textNodes=[];let node;
    while((node=walker.nextNode()))if(!node.parentElement.closest("a,code"))textNodes.push(node);
    const urlPattern=/https?:\/\/[^\s<>"']+/gi;
    textNodes.forEach(textNode=>{
      const value=textNode.nodeValue,fragment=document.createDocumentFragment();let last=0,match,changed=false;
      urlPattern.lastIndex=0;
      while((match=urlPattern.exec(value))){
        let url=match[0];while(/[.,!?;:]$/.test(url))url=url.slice(0,-1);
        if(!url)continue;
        const start=match.index,end=start+url.length;
        if(start>last)fragment.append(document.createTextNode(value.slice(last,start)));
        const anchor=document.createElement("a");anchor.href=url;anchor.target="_blank";anchor.rel="noopener noreferrer";anchor.textContent=url;fragment.append(anchor);
        last=end;changed=true;urlPattern.lastIndex=end;
      }
      if(changed){if(last<value.length)fragment.append(document.createTextNode(value.slice(last)));textNode.replaceWith(fragment);}
    });
    return template.innerHTML;
  }
  function listItemHtml(source,lineIndex){
    const checkbox=source.match(/^\[\s*([xX])?\s*\]\s*(.*)$/);
    if(!checkbox)return "<li>"+inlineMarkdown(source)+"</li>";
    return '<li class="checklist-item"><input type="checkbox" data-checklist-line="'+lineIndex+'" aria-label="Checklisteneintrag erledigt" '+(checkbox[1]?"checked":"")+'>'+inlineMarkdown(checkbox[2])+"</li>";
  }
  function markdownToHtml(markdown){
    const lines=String(markdown||"").replace(/\r/g,"").split("\n");let html="",list="";
    const closeList=()=>{if(list){html+="</"+list+">";list="";}};
    for(let lineIndex=0;lineIndex<lines.length;lineIndex++){const line=lines[lineIndex];if(!line.trim()){closeList();continue;}let match;
      if((match=line.match(/^(#{1,3})\s+(.+)$/))){closeList();const level=match[1].length;html+="<h"+level+">"+inlineMarkdown(match[2])+"</h"+level+">";}
      else if((match=line.match(/^\s*>\s?(.*)$/))){closeList();html+="<blockquote>"+inlineMarkdown(match[1])+"</blockquote>";}
      else if((match=line.match(/^\s*[-*+]\s*(.*)$/))){if(list!=="ul"){closeList();html+="<ul>";list="ul";}html+=listItemHtml(match[1],lineIndex);}
      else if((match=line.match(/^\s*\d+\.\s*(.*)$/))){if(list!=="ol"){closeList();html+="<ol>";list="ol";}html+=listItemHtml(match[1],lineIndex);}
      else{closeList();html+="<p>"+inlineMarkdown(line)+"</p>";}
    }closeList();return linkifyHtml(html);
  }
  function cardHtml(task){
    const labels=(task.labelIds||[]).slice(0,2).map(labelById).filter(Boolean).map(label=>'<span class="label-chip" style="'+labelStyle(label.color)+'"><span class="label-dot"></span>'+esc(label.name)+'</span>').join("");
    const due=task.dueDate?'<span class="due-date '+(task.dueDate<dateToday()?"overdue":task.dueDate===dateToday()?"today":"")+'"><svg><use href="#i-calendar"/></svg>'+esc(prettyDate(task.dueDate))+'</span>':"";
    const desc=plainDescription(task.description);
    const footer=due||labels?'<div class="card-meta">'+due+(labels?'<div class="card-labels">'+labels+'</div>':"")+'</div>':"";
    return '<article class="task-card" draggable="true" data-task-id="'+esc(task.id)+'" tabindex="0" aria-label="'+esc(task.title)+'"><div class="card-top"><div class="card-title">'+esc(task.title)+'</div><button type="button" class="icon-button card-edit" data-edit-task="'+esc(task.id)+'" aria-label="Task bearbeiten"><svg><use href="#i-edit"/></svg></button></div>'+(desc?'<div class="card-description">'+esc(desc)+'</div>':"")+footer+'</article>';
  }
  function columnHtml(column){
    const tasks=tasksIn(column.id),query=$("searchInput").value.trim().toLowerCase();
    const visible=tasks.filter(task=>!query||(task.title+" "+plainDescription(task.description)+" "+(task.labelIds||[]).map(id=>(labelById(id)||{}).name||"").join(" ")).toLowerCase().includes(query));
    return '<section class="column" data-column-id="'+esc(column.id)+'"><header class="column-header" draggable="true" data-column-grip="'+esc(column.id)+'"><button type="button" class="icon-button column-grip" tabindex="-1" aria-label="Spalte verschieben"><svg><use href="#i-grip"/></svg></button><span class="column-title">'+esc(column.name)+'</span><span class="column-count">'+tasks.length+'</span><div class="column-actions"><button type="button" class="icon-button" data-edit-column="'+esc(column.id)+'" aria-label="Spalte bearbeiten"><svg><use href="#i-more"/></svg></button></div></header><div class="column-list" data-drop-column="'+esc(column.id)+'">'+(visible.length?visible.map(cardHtml).join(""):(query?'<div class="empty-column">Keine passenden Tasks</div>':tasks.length?"":'<div class="empty-column">Hier ist noch Platz für deinen nächsten Task.</div>'))+'<button type="button" class="add-task-inline" data-new-task="'+esc(column.id)+'"><svg><use href="#i-add"/></svg>Task hinzufügen</button></div></section>';
  }
  function render(){
    $("boardSelect").innerHTML=workspace.boards.map(board=>'<option value="'+esc(board.id)+'">'+esc(board.name)+'</option>').join("");
    $("boardSelect").value=workspace.activeBoardId;
    $("boardSelect").title=workspace.boards.find(board=>board.id===workspace.activeBoardId).name;
    boardEl.innerHTML=state.columns.map(columnHtml).join("");bindBoardEvents();
    if($("boardsDialog").open)renderBoardList();
  }
  function clearBoardContext(){
    ["taskDialog","labelsDialog","columnDialog"].forEach(id=>{if($(id).open)$(id).close();});
    draggedTask=null;draggedColumn=null;$("searchInput").value="";
    if(descriptionEditing)setDescriptionEditing(false);
    const viewport=document.querySelector(".board-viewport");viewport.scrollLeft=0;viewport.scrollTop=0;
  }
  function switchBoard(id){
    if(id===workspace.activeBoardId||!workspace.boards.some(board=>board.id===id))return;
    useWorkspace(workspace,id);clearBoardContext();save();render();
  }
  function resetBoardEditor(){
    $("boardId").value="";$("boardName").value="";$("boardEditorHeading").textContent="Neues Board";$("saveBoard").textContent="Board hinzufügen";
  }
  function renderBoardList(){
    $("boardCount").textContent=workspace.boards.length+" "+(workspace.boards.length===1?"Board":"Boards");
    $("boardList").innerHTML=workspace.boards.map(board=>{
      const active=board.id===workspace.activeBoardId,onlyBoard=workspace.boards.length===1;
      return '<div class="board-row'+(active?' active':'')+'"><div class="board-row-details"><strong>'+esc(board.name)+(active?' <span class="active-board-badge">Aktiv</span>':'')+'</strong><small>'+board.data.tasks.length+' '+(board.data.tasks.length===1?'Task':'Tasks')+' · '+board.data.columns.length+' '+(board.data.columns.length===1?'Spalte':'Spalten')+'</small></div><div class="board-row-actions"><button type="button" class="icon-button" data-board-rename="'+esc(board.id)+'" aria-label="Board '+esc(board.name)+' umbenennen" title="Board umbenennen"><svg><use href="#i-edit"/></svg></button><button type="button" class="icon-button danger-button" data-board-delete="'+esc(board.id)+'" aria-label="Board '+esc(board.name)+' löschen" title="'+(onlyBoard?'Mindestens ein Board muss erhalten bleiben':'Board löschen')+'" '+(onlyBoard?'disabled':'')+'><svg><use href="#i-delete"/></svg></button></div></div>';
    }).join("");
    $("boardList").querySelectorAll("[data-board-rename]").forEach(button=>button.addEventListener("click",()=>{
      const board=workspace.boards.find(item=>item.id===button.dataset.boardRename);if(!board)return;
      $("boardId").value=board.id;$("boardName").value=board.name;$("boardEditorHeading").textContent="Board umbenennen";$("saveBoard").textContent="Name speichern";$("boardName").focus();$("boardName").select();
    }));
    $("boardList").querySelectorAll("[data-board-delete]").forEach(button=>button.addEventListener("click",()=>{
      const id=button.dataset.boardDelete,index=workspace.boards.findIndex(board=>board.id===id),board=workspace.boards[index];if(!board)return;
      if(workspace.boards.length<=1){showToast("Mindestens ein Board muss erhalten bleiben.");return;}
      const count=board.data.tasks.length;
      if(!window.confirm('Board „'+board.name+'“ mit '+count+' '+(count===1?'Task':'Tasks')+' löschen? Alle Spalten, Labels und Beschreibungen dieses Boards werden ebenfalls gelöscht.'))return;
      workspace.boards=workspace.boards.filter(item=>item.id!==id);
      if(workspace.activeBoardId===id){useWorkspace(workspace,workspace.boards[Math.min(index,workspace.boards.length-1)].id);clearBoardContext();}
      if($("boardId").value===id)resetBoardEditor();
      save();render();showToast("Board gelöscht");
    }));
  }
  $("boardSelect").addEventListener("change",event=>switchBoard(event.target.value));
  $("manageBoards").addEventListener("click",()=>{renderBoardList();resetBoardEditor();$("boardsDialog").showModal();$("boardName").focus();});
  $("resetBoardEditor").addEventListener("click",()=>{resetBoardEditor();$("boardName").focus();});
  $("boardForm").addEventListener("submit",event=>{
    event.preventDefault();const name=$("boardName").value.trim();if(!name){$("boardName").focus();return;}
    const id=$("boardId").value,existing=workspace.boards.find(board=>board.id===id);
    if(id&&!existing){resetBoardEditor();showToast("Dieses Board wurde bereits gelöscht.");return;}
    if(existing)existing.name=name;
    else{const board={id:newId("board-"),name,data:starter()};workspace.boards.push(board);useWorkspace(workspace,board.id);clearBoardContext();}
    save();render();resetBoardEditor();showToast(existing?"Board umbenannt":"Board hinzugefügt");
  });
  function publishWorkspace(value){try{if(boardChannel)boardChannel.postMessage({type:"workspace-updated",data:cloneBoard(value)});}catch(error){}}
  function connectBoardSync(){
    if(!("BroadcastChannel" in window))return;
    try{
      boardChannel=new BroadcastChannel(DATABASE_NAME);
      boardChannel.addEventListener("message",event=>{
        if(!event.data||event.data.type!=="workspace-updated")return;
        try{
          const incoming=normalizeBackup(event.data.data).data,previousBoardId=workspace.activeBoardId;
          useWorkspace(incoming,previousBoardId);
          if(workspace.activeBoardId!==previousBoardId){clearBoardContext();showToast("Das bisherige Board wurde in einem anderen Tab entfernt.");}
          if($("boardId").value&&!workspace.boards.some(board=>board.id===$("boardId").value))resetBoardEditor();
          render();
        }catch(error){}
      });
    }catch(error){boardChannel=null;}
  }
  function bindBoardEvents(){
    boardEl.querySelectorAll(".task-card").forEach(card=>{
      card.addEventListener("click",event=>{if(event.target.closest("button"))return;openTask(card.dataset.taskId);});
      card.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();openTask(card.dataset.taskId);}});
      card.addEventListener("dragstart",event=>{draggedTask=card.dataset.taskId;draggedColumn=null;event.dataTransfer.setData("text/plain",draggedTask);event.dataTransfer.effectAllowed="move";card.classList.add("dragging");});
      card.addEventListener("dragend",()=>{draggedTask=null;boardEl.querySelectorAll(".drag-over,.drop-target,.dragging,.drop-before,.drop-after").forEach(node=>node.classList.remove("drag-over","drop-target","dragging","drop-before","drop-after"));});
      card.addEventListener("dragover",event=>{if(!draggedTask)return;event.preventDefault();event.stopPropagation();boardEl.querySelectorAll(".task-card.drop-target").forEach(node=>{if(node!==card)node.classList.remove("drop-target","drop-before","drop-after");});const rect=card.getBoundingClientRect();const after=event.clientY>rect.top+rect.height/2;card.classList.add("drop-target");card.classList.toggle("drop-before",!after);card.classList.toggle("drop-after",after);});
      card.addEventListener("dragleave",event=>{if(event.relatedTarget&&card.contains(event.relatedTarget))return;card.classList.remove("drop-target","drop-before","drop-after");});
      card.addEventListener("drop",event=>{if(!draggedTask)return;event.preventDefault();event.stopPropagation();if(card.dataset.taskId===draggedTask)return;const destinationId=card.closest(".column").dataset.columnId;const ordered=tasksIn(destinationId).filter(task=>task.id!==draggedTask);const targetIndex=ordered.findIndex(task=>task.id===card.dataset.taskId);const rect=card.getBoundingClientRect();const after=event.clientY>rect.top+rect.height/2;const before=ordered[targetIndex+(after?1:0)];moveTask(draggedTask,destinationId,before?before.id:null);});
    });
    boardEl.querySelectorAll(".column-list").forEach(list=>{
      list.addEventListener("dragover",event=>{if(!draggedTask)return;event.preventDefault();list.classList.add("drag-over");});
      list.addEventListener("dragleave",event=>{if(event.target===list)list.classList.remove("drag-over");});
      list.addEventListener("drop",event=>{if(!draggedTask||event.target.closest(".task-card"))return;event.preventDefault();event.stopPropagation();list.classList.remove("drag-over");moveTask(draggedTask,list.dataset.dropColumn,null);});
    });
    boardEl.querySelectorAll("[data-column-grip]").forEach(header=>{
      header.addEventListener("dragstart",event=>{draggedColumn=header.dataset.columnGrip;draggedTask=null;event.dataTransfer.setData("text/plain",draggedColumn);event.dataTransfer.effectAllowed="move";});
      header.addEventListener("dragover",event=>{if(draggedColumn)event.preventDefault();});
      header.addEventListener("drop",event=>{if(!draggedColumn)return;event.preventDefault();event.stopPropagation();reorderColumn(draggedColumn,header.dataset.columnGrip);draggedColumn=null;});
      header.addEventListener("dragend",()=>{draggedColumn=null;});
    });
    boardEl.querySelectorAll("[data-new-task]").forEach(button=>button.addEventListener("click",()=>openTask(null,button.dataset.newTask)));
    boardEl.querySelectorAll("[data-edit-task]").forEach(button=>button.addEventListener("click",event=>{event.stopPropagation();openTask(button.dataset.editTask);}));
    boardEl.querySelectorAll("[data-edit-column]").forEach(button=>button.addEventListener("click",event=>{event.stopPropagation();openColumn(button.dataset.editColumn);}));
  }
  function moveTask(taskId,destinationId,beforeId){
    if(taskId===beforeId)return;const original=state.tasks.find(task=>task.id===taskId);
    if(!original||!state.columns.some(column=>column.id===destinationId))return;
    const rows=state.tasks.filter(task=>task.columnId===destinationId&&task.id!==taskId).sort((a,b)=>(a.order||0)-(b.order||0));
    const at=beforeId?rows.findIndex(task=>task.id===beforeId):-1;rows.splice(at<0?rows.length:at,0,{...original,columnId:destinationId});
    state.tasks=state.columns.flatMap(column=>{const group=column.id===destinationId?rows:state.tasks.filter(task=>task.columnId===column.id&&task.id!==taskId).sort((a,b)=>(a.order||0)-(b.order||0));return group.map((task,index)=>({...task,order:index}));});
    save();render();
  }
  function reorderColumn(sourceId,targetId){if(sourceId===targetId)return;const from=state.columns.findIndex(column=>column.id===sourceId),to=state.columns.findIndex(column=>column.id===targetId);if(from<0||to<0)return;const [column]=state.columns.splice(from,1);state.columns.splice(to,0,column);save();render();}
  function fillColumnSelect(selected){$("taskColumn").innerHTML=state.columns.map(column=>'<option value="'+esc(column.id)+'">'+esc(column.name)+'</option>').join("");$("taskColumn").value=state.columns.some(column=>column.id===selected)?selected:state.columns[0].id;}
  function renderLabelPicker(selectedIds){
    const chosen=[...new Set(selectedIds||[])].slice(0,2);
    $("taskLabels").innerHTML=state.labels.length?state.labels.map(label=>'<label class="label-option" style="'+labelStyle(label.color)+'"><input type="checkbox" value="'+esc(label.id)+'" '+(chosen.includes(label.id)?"checked":"")+'><span class="label-dot"></span>'+esc(label.name)+'</label>').join(""):'<span class="helper-text">Noch keine Labels angelegt.</span>';
    const updateLimit=()=>{
      const inputs=[...$("taskLabels").querySelectorAll("input[type=checkbox]")];
      const selected=inputs.filter(input=>input.checked).length;
      inputs.forEach(input=>input.disabled=!input.checked&&selected>=2);
      $("labelSelectionNote").textContent=selected+" von 2 Labels ausgewählt";
    };
    $("taskLabels").querySelectorAll("input[type=checkbox]").forEach(input=>input.addEventListener("change",updateLimit));
    updateLimit();
  }
  let descriptionEditor=null,descriptionEditorContainer=$("taskDescription");
  if(window.EasyMDE){
    try{
      descriptionEditor=new window.EasyMDE({
        element:$("taskDescription"),
        autoDownloadFontAwesome:false,
        autoRefresh:{delay:300},
        forceSync:true,
        lineWrapping:true,
        maxHeight:"280px",
        placeholder:"Schreibe eine Beschreibung in Markdown …",
        previewRender:markdownToHtml,
        promptURLs:true,
        promptTexts:{image:"Bild-URL eingeben (https://… oder lokale Datei mit file:///…):",link:"Link-URL eingeben:"},
        spellChecker:false,
        status:false,
        toolbar:["bold","italic","heading","|","quote","code","unordered-list","ordered-list","|","link",{
          name:"image",action:window.EasyMDE.drawImage,className:"fa fa-picture-o",title:"Bild per URL einfügen"
        },"|","preview","side-by-side","fullscreen","guide"]
      });
      descriptionEditorContainer=descriptionEditor.codemirror.getWrapperElement().parentElement;
      descriptionEditorContainer.classList.add("hidden");
    }catch(error){descriptionEditor=null;showToast("EasyMDE konnte nicht geladen werden. Der einfache Texteingabemodus bleibt verfügbar.");}
  }
  function descriptionValue(){return descriptionEditor?descriptionEditor.value():$("taskDescription").value;}
  function setDescriptionValue(value){const text=String(value||"");$("taskDescription").value=text;if(descriptionEditor)descriptionEditor.value(text);}
  function openTask(taskId,columnId){
    const task=taskId?state.tasks.find(item=>item.id===taskId):null;$("taskForm").dataset.taskId=task?task.id:"";
    $("taskDialogTitle").textContent=task?"Task bearbeiten":"Task erstellen";$("taskEyebrow").textContent=task?"TASK-DETAILS":"NEUER EINTRAG";
    $("taskTitle").value=task?task.title:"";$("taskDue").value=task?task.dueDate||"":"";
    setDescriptionValue(task?task.description||"":"");fillColumnSelect(task?task.columnId:columnId||state.columns[0].id);renderLabelPicker(task?task.labelIds||[]:[]);setDescriptionEditing(false);
    $("createdAtNote").textContent=task&&task.createdAt?"Erstellt am "+new Intl.DateTimeFormat("de-DE",{dateStyle:"long"}).format(new Date(task.createdAt)):"Das Erstelldatum wird beim Speichern automatisch gesetzt.";
    $("deleteTask").classList.toggle("hidden",!task);$("taskDialog").showModal();$("taskTitle").focus();
  }
  let descriptionEditing=false;
  function renderDescription(){
    const source=descriptionValue().trim();
    $("descriptionRendered").innerHTML=source?markdownToHtml(source):'<p class="description-placeholder">Noch keine Beschreibung. Klicke hier, um eine hinzuzufügen.</p>';
  }
  function setDescriptionEditing(editing){
    descriptionEditing=editing;
    $("descriptionDisplay").classList.toggle("hidden",editing);
    if(descriptionEditor){$("taskDescription").classList.add("hidden");descriptionEditorContainer.classList.toggle("hidden",!editing);}
    else $("taskDescription").classList.toggle("hidden",!editing);
    $("copyDescription").classList.toggle("hidden",editing||!descriptionValue().trim());
    if(!editing)renderDescription();
    else setTimeout(()=>{if(descriptionEditor){descriptionEditor.codemirror.refresh();descriptionEditor.codemirror.focus();}else $("taskDescription").focus();},0);
  }
  function copyPlainTextFallback(text){
    const textarea=document.createElement("textarea");
    textarea.value=text;textarea.setAttribute("readonly","");textarea.style.position="fixed";textarea.style.left="-9999px";
    document.body.append(textarea);
    try{textarea.select();return document.execCommand("copy");}finally{textarea.remove();}
  }
  async function copyRenderedDescription(){
    const content=$("descriptionRendered").cloneNode(true);
    content.querySelectorAll('input[type="checkbox"]').forEach(input=>input.replaceWith(document.createTextNode(input.checked?"☑ ":"☐ ")));
    content.querySelectorAll("img").forEach(image=>image.replaceWith(document.createTextNode(image.alt||"")));
    const copyContainer=document.createElement("div");
    copyContainer.style.cssText="position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none";
    copyContainer.append(content);document.body.append(copyContainer);
    const html=content.innerHTML,text=content.innerText||content.textContent||"";
    copyContainer.remove();
    let copied=false;
    try{
      if(navigator.clipboard&&navigator.clipboard.write&&window.ClipboardItem){
        await navigator.clipboard.write([new ClipboardItem({"text/html":new Blob([html],{type:"text/html"}),"text/plain":new Blob([text],{type:"text/plain"})})]);
        copied=true;
      }else if(navigator.clipboard&&navigator.clipboard.writeText){
        await navigator.clipboard.writeText(text);
        copied=true;
      }
    }catch(error){}
    if(!copied){try{copied=copyPlainTextFallback(text);}catch(error){}}
    showToast(copied?"Beschreibung kopiert":"Beschreibung konnte nicht kopiert werden");
  }
  $("copyDescription").addEventListener("click",copyRenderedDescription);
  $("descriptionDisplay").addEventListener("click",event=>{
    if(event.target.closest("a,input[type=checkbox]"))return;
    setDescriptionEditing(true);
  });
  $("descriptionDisplay").addEventListener("keydown",event=>{
    if(event.target.closest("a,input[type=checkbox]"))return;
    if(event.key==="Enter"||event.key===" "){event.preventDefault();setDescriptionEditing(true);}
  });
  $("descriptionRendered").addEventListener("change",event=>{
    const checkbox=event.target.closest('input[type="checkbox"][data-checklist-line]');if(!checkbox)return;
    const lineIndex=Number(checkbox.dataset.checklistLine),lines=descriptionValue().replace(/\r/g,"").split("\n"),line=lines[lineIndex];
    const marker=line&&line.match(/^(\s*(?:[-*+]|\d+\.)\s*)\[\s*([xX])?\s*\]/);if(!marker)return;
    lines[lineIndex]=marker[1]+"["+(checkbox.checked?"x":" ")+"]"+line.slice(marker[0].length);
    setDescriptionValue(lines.join("\n"));renderDescription();
  });
  if(!descriptionEditor)$("taskDescription").addEventListener("keydown",event=>{
    if(event.key!=="Enter"||event.shiftKey||event.isComposing||event.selectionStart!==event.selectionEnd)return;
    const editor=event.currentTarget,value=editor.value,caret=editor.selectionStart;
    const lineStart=value.lastIndexOf("\n",caret-1)+1,lineEndFound=value.indexOf("\n",caret);
    const lineEnd=lineEndFound<0?value.length:lineEndFound,line=value.slice(lineStart,lineEnd);
    const before=line.slice(0,caret-lineStart);
    const unordered=before.match(/^([ \t]*)([-*+])([ \t]+)/);
    const ordered=before.match(/^([ \t]*)(\d+)\.([ \t]+)/);
    const marker=unordered||ordered;
    if(!marker)return;
    let prefixLength=marker[0].length;
    const checkbox=before.slice(prefixLength).match(/^\[(?:\s*[xX]?\s*)\](?:[ \t]+|$)/);
    if(checkbox)prefixLength+=checkbox[0].length;
    if(line.slice(prefixLength).trim()===""){
      event.preventDefault();
      const beforeLine=value.slice(0,lineStart),afterLine=lineEnd<value.length?value.slice(lineEnd+1):"";
      editor.value=beforeLine+"\n"+afterLine;
      editor.setSelectionRange(beforeLine.length+1,beforeLine.length+1);
      editor.dispatchEvent(new Event("input",{bubbles:true}));
      return;
    }
    const nextMarker=unordered
      ?unordered[1]+unordered[2]+unordered[3]
      :ordered[1]+(Number(ordered[2])+1)+"."+ordered[3];
    const nextPrefix=nextMarker+(checkbox?"[ ] ":"");
    event.preventDefault();
    editor.value=value.slice(0,caret)+"\n"+nextPrefix+value.slice(caret);
    const nextCaret=caret+1+nextPrefix.length;
    editor.setSelectionRange(nextCaret,nextCaret);
    editor.dispatchEvent(new Event("input",{bubbles:true}));
    requestAnimationFrame(()=>{
      if(editor.selectionStart===editor.value.length)editor.scrollTop=editor.scrollHeight;
    });
  });
  document.addEventListener("pointerdown",event=>{
    const editorRoot=descriptionEditor?descriptionEditorContainer:$("taskDescription");
    if(descriptionEditing&&!editorRoot.contains(event.target))setDescriptionEditing(false);
  });
  $("taskForm").addEventListener("submit",event=>{
    event.preventDefault();const title=$("taskTitle").value.trim();if(!title){$("taskTitle").focus();return;}
    const id=$("taskForm").dataset.taskId,old=state.tasks.find(task=>task.id===id),columnId=$("taskColumn").value;
    const labels=[...new Set([...$("taskLabels").querySelectorAll("input:checked")].map(input=>input.value))].slice(0,2);
    if(old&&old.columnId!==columnId)state.tasks=state.tasks.filter(task=>task.id!==old.id);
    const record={id:old?old.id:newId("task-"),title,createdAt:old?old.createdAt:new Date().toISOString(),dueDate:$("taskDue").value||"",description:descriptionValue(),labelIds:labels,columnId,order:old&&old.columnId===columnId?old.order:tasksIn(columnId).length};
    const index=state.tasks.findIndex(task=>task.id===record.id);if(index>=0)state.tasks[index]=record;else state.tasks.push(record);
    save();$("taskDialog").close();render();showToast(old?"Task aktualisiert":"Task erstellt");
  });
  $("deleteTask").addEventListener("click",()=>{const id=$("taskForm").dataset.taskId;if(!id)return;state.tasks=state.tasks.filter(task=>task.id!==id);save();$("taskDialog").close();render();showToast("Task gelöscht");});
  function resetLabelEditor(){$("labelId").value="";$("labelName").value="";$("labelColor").value="#6750a4";$("labelEditorHeading").textContent="Neues Label";}
  function renderLabelList(){
    $("labelCount").textContent=state.labels.length+" "+(state.labels.length===1?"Label":"Labels");
    $("labelList").innerHTML=state.labels.length?state.labels.map(label=>'<div class="label-row"><span class="label-chip" style="'+labelStyle(label.color)+'"><span class="label-dot"></span><span class="label-row-name">'+esc(label.name)+'</span></span><div class="label-row-actions"><button type="button" class="icon-button" data-label-edit="'+esc(label.id)+'" aria-label="Label bearbeiten"><svg><use href="#i-edit"/></svg></button><button type="button" class="icon-button" data-label-delete="'+esc(label.id)+'" aria-label="Label löschen"><svg><use href="#i-delete"/></svg></button></div></div>').join(""):'<div class="empty-column">Lege dein erstes Label an.</div>';
    $("labelList").querySelectorAll("[data-label-edit]").forEach(button=>button.addEventListener("click",()=>{const label=labelById(button.dataset.labelEdit);if(!label)return;$("labelId").value=label.id;$("labelName").value=label.name;$("labelColor").value=safeColor(label.color);$("labelEditorHeading").textContent="Label bearbeiten";$("labelName").focus();}));
    $("labelList").querySelectorAll("[data-label-delete]").forEach(button=>button.addEventListener("click",()=>{const id=button.dataset.labelDelete;state.labels=state.labels.filter(label=>label.id!==id);state.tasks.forEach(task=>task.labelIds=(task.labelIds||[]).filter(labelId=>labelId!==id));save();renderLabelList();renderLabelPicker([...$("taskLabels").querySelectorAll("input:checked")].map(input=>input.value));render();showToast("Label gelöscht");}));
  }
  function openLabels(){renderLabelList();resetLabelEditor();$("labelsDialog").showModal();}
  $("labelForm").addEventListener("submit",event=>{
    event.preventDefault();const name=$("labelName").value.trim();if(!name)return;const id=$("labelId").value,existing=state.labels.find(label=>label.id===id);
    if(existing){existing.name=name;existing.color=safeColor($("labelColor").value);}else state.labels.push({id:newId("label-"),name,color:safeColor($("labelColor").value)});
    save();renderLabelList();resetLabelEditor();const selected=[...$("taskLabels").querySelectorAll("input:checked")].map(input=>input.value);renderLabelPicker(selected);render();showToast("Label gespeichert");
  });
  $("resetLabelEditor").addEventListener("click",resetLabelEditor);$("manageLabels").addEventListener("click",openLabels);$("labelsFromTask").addEventListener("click",openLabels);
  function openColumn(id){const column=state.columns.find(item=>item.id===id);$("columnId").value=column?column.id:"";$("columnName").value=column?column.name:"";$("columnDialogTitle").textContent=column?"Spalte bearbeiten":"Spalte hinzufügen";$("deleteColumn").classList.toggle("hidden",!column);$("columnDialog").showModal();$("columnName").focus();}
  $("addColumn").addEventListener("click",()=>openColumn(null));
  $("columnForm").addEventListener("submit",event=>{event.preventDefault();const name=$("columnName").value.trim();if(!name)return;const id=$("columnId").value,column=state.columns.find(item=>item.id===id);if(column)column.name=name;else state.columns.push({id:newId("column-"),name});save();$("columnDialog").close();render();showToast(column?"Spalte aktualisiert":"Spalte hinzugefügt");});
  $("deleteColumn").addEventListener("click",()=>{
    const id=$("columnId").value,column=state.columns.find(item=>item.id===id);if(!column)return;
    if(state.columns.length<=1){showToast("Mindestens eine Spalte muss erhalten bleiben.");return;}
    const target=state.columns.find(item=>item.id!==id),moving=tasksIn(id);
    if(moving.length&&!window.confirm("Die "+moving.length+" Tasks werden nach „"+target.name+"“ verschoben. Spalte löschen?"))return;
    const targetRows=tasksIn(target.id);moving.forEach((task,index)=>{task.columnId=target.id;task.order=targetRows.length+index;});
    state.columns=state.columns.filter(item=>item.id!==id);save();$("columnDialog").close();render();showToast("Spalte gelöscht");
  });
  $("searchInput").addEventListener("input",render);
  $("themeToggle").addEventListener("click",()=>applyTheme(document.body.dataset.theme==="dark"?"light":"dark"));
  $("sizeToggle").addEventListener("click",()=>{
    applyDisplaySize(document.documentElement.dataset.displaySize==="small"?"large":"small");
    if(descriptionEditor)descriptionEditor.codemirror.refresh();
  });
  $("dataTransferToggle").addEventListener("click",()=>{const status=$("dataTransferStatus");status.textContent="";status.classList.remove("error");$("dataDialog").showModal();});
  $("exportData").addEventListener("click",async()=>{
    await persistenceQueue;
    let exportState=workspace;
    if(persistenceHealthy){try{exportState=normalizeBackup(await readStoredWorkspace()||workspace).data;}catch(error){}}
    const backup={format:"gtd-taskmanager-backup",version:2,exportedAt:new Date().toISOString(),data:cloneBoard(exportState)};
    const file=new Blob([JSON.stringify(backup,null,2)],{type:"application/json"}),url=URL.createObjectURL(file),link=document.createElement("a");
    link.href=url;link.download="aufgaben-backup-"+dateToday()+".json";document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    $("dataTransferStatus").classList.remove("error");$("dataTransferStatus").textContent="Backup aller Boards wurde heruntergeladen.";
  });
  $("chooseImportFile").addEventListener("click",()=>$("importDataFile").click());
  $("importDataFile").addEventListener("change",async event=>{
    const file=event.target.files&&event.target.files[0];if(!file)return;const status=$("dataTransferStatus");status.textContent="";status.classList.remove("error");
    try{
      const parsed=JSON.parse(await file.text()),backup=normalizeBackup(parsed);
      if(!window.confirm("Der Import ersetzt alle aktuell gespeicherten Boards einschließlich ihrer Tasks, Spalten und Labels durch "+backup.data.boards.length+" "+(backup.data.boards.length===1?"Board":"Boards")+" aus dem Backup. Möchtest du fortfahren?"))return;
      try{await persistenceQueue;await writeStoredWorkspace(backup.data);}catch(error){throw new Error("Das Backup konnte nicht in IndexedDB gespeichert werden. Prüfe, ob dein Browser IndexedDB erlaubt.");}
      persistenceQueue=Promise.resolve(true);persistenceHealthy=true;storageWarningShown=false;try{localStorage.removeItem(LEGACY_KEY);}catch(error){}
      useWorkspace(backup.data);clearBoardContext();resetBoardEditor();render();publishWorkspace(workspace);$("dataDialog").close();showToast(backup.shortenedLabels?"Backup importiert. Pro Task wurden höchstens 2 Labels übernommen.":"Backup erfolgreich importiert.");
    }catch(error){status.classList.add("error");status.textContent=error instanceof SyntaxError?"Die Datei enthält kein gültiges JSON.":error.message||"Das Backup konnte nicht importiert werden.";}
    finally{event.target.value="";}
  });
  document.querySelectorAll("[data-close]").forEach(button=>button.addEventListener("click",()=>$(button.dataset.close).close()));
  document.addEventListener("keydown",event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="k"){event.preventDefault();$("searchInput").focus();}if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="n"){event.preventDefault();openTask(null);}});
  connectBoardSync();
  initializeStorage();
})();
