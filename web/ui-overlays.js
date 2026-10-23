// One modal surface. Uses the browser top layer, with an inert/focus-trapped fallback.
export class ModalSurface {
  constructor({window,document,panel,onClose,opener}) {
    Object.assign(this,{window,document,panel,onClose,opener});this.active=false;this.saved=[];
    panel.addEventListener('cancel',event=>{event.preventDefault();this.onClose();});
    panel.addEventListener('keydown',event=>{
      if(!this.active)return;
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.onClose();return;}
      if(event.key!=='Tab')return;
      const fields=this.focusable(),first=fields[0]||panel,last=fields.at(-1)||panel;
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel)){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    });
    this.guard=event=>{if(this.active&&!panel.contains(event.target))(this.focusable()[0]||panel).focus();};
    document.addEventListener('focusin',this.guard);
  }
  focusable(){return [...this.panel.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(el=>!el.disabled&&!el.closest('[hidden]')&&el.tabIndex>=0);}
  open(returnFocus=null){
    if(this.active)return;this.active=true;this.previous=returnFocus||this.document.activeElement;
    this.panel.hidden=false;this.panel.setAttribute('aria-modal','true');
    this.overflow=this.document.body.style.overflow;this.document.body.style.overflow='hidden';
    try{if(typeof this.panel.showModal==='function')this.panel.showModal();}catch{}
    // Also applied in fallback implementations; preserve all preexisting inert values.
    let branch=this.panel;
    while(branch.parentElement){for(const sibling of branch.parentElement.children)if(sibling!==branch){this.saved.push([sibling,sibling.inert,sibling.hasAttribute('inert')]);sibling.inert=true;sibling.setAttribute('inert','');}branch=branch.parentElement;if(branch===this.document.body)break;}
    (this.focusable()[0]||this.panel).focus();
  }
  close(){
    if(!this.active){this.panel.hidden=true;return;}
    this.active=false;
    try{if(this.panel.open&&typeof this.panel.close==='function')this.panel.close();}catch{}
    this.panel.hidden=true;this.panel.removeAttribute('aria-modal');
    for(const [element,value,attribute] of this.saved){element.inert=value;if(!attribute)element.removeAttribute('inert');}
    this.saved=[];this.document.body.style.overflow=this.overflow;
    const target=this.previous?.isConnected&&!this.previous.closest('[hidden]')?this.previous:this.opener;
    if(target&&!target.closest('[hidden]'))target.focus();
  }
  dispose(){this.close();this.document.removeEventListener('focusin',this.guard);}
}
