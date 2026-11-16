// Narrow DOM adapter for the observed inline Greenhouse ReactSelect widget.
// No search text, arbitrary wrapper discovery, payload inference or submission.
const hold=(code,message)=>Object.assign(new Error(message),{code,hold:true});
const normalize=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
const unsupported=()=>hold('custom_form_controls','This custom choice does not expose an unambiguous static single-choice control. Continue it manually.');
async function checked(guard,operation){guard();let result;try{result=await operation();}catch(error){guard();if(error.hold)throw error;throw hold('custom_form_controls','The custom employer choice could not be read or operated reliably. Continue it manually.');}guard();return result;}

function capture(el){
 const visible=node=>node?.isConnected&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden'&&!node.closest('[hidden],[aria-hidden="true"]');
 const uniqueId=node=>node.id&&node.id.length<=300&&/^[A-Za-z0-9_:-]+$/.test(node.id)&&[...document.querySelectorAll('[id]')].filter(other=>other.id===node.id).length===1;
 const activatable='label,a,button,input,select,textarea,summary,details,iframe,object,embed,[contenteditable]:not([contenteditable="false"]),[role=button],[role=link]';
 const fail=()=>({unsupported:true});
 if(el.tagName!=='INPUT'||el.type!=='text'||el.getAttribute('role')!=='combobox'||!el.classList.contains('select__input')||!visible(el)||el.matches(':disabled')||el.getAttribute('aria-autocomplete')!=='list'||!['true','listbox'].includes(el.getAttribute('aria-haspopup'))||!uniqueId(el)||el.value)return fail();
 const form=el.form,control=el.closest('.select__control'),container=el.closest('.select__value-container'),widget=control?.parentElement;
 if(!form||!control||!container||!widget||control.tagName!=='DIV'||container.tagName!=='DIV'||widget.tagName!=='DIV'||widget===form||!form.contains(widget)||widget.closest('form')!==form||el.parentElement.closest(activatable)||control.closest('form')!==form||control.querySelectorAll('.select__value-container').length!==1||control.querySelectorAll('input[role=combobox]').length!==1||widget.querySelectorAll('.select__control').length!==1||!container.contains(el)||widget.querySelector('.select__multi-value,.select__loading-indicator,[aria-busy="true"]')||container.classList.contains('select__value-container--is-multi'))return fail();
 // The observed widget is the immediate narrow DIV containing the control,
 // its inline menu and, only when present, its own question's hidden value.
 if([...widget.childNodes].some(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim())||[...widget.children].some(node=>node!==control&&!(node.tagName==='INPUT'&&node.type==='hidden')&&!(node.tagName==='DIV'&&(node.classList.contains('select__menu')||node.classList.contains('select__menu-list')))))return fail();
 const formToken=form.getAttribute('data-hub-form');if(!formToken||[...document.forms].filter(other=>other.getAttribute('data-hub-form')===formToken).length!==1)return fail();
 if(!widget.hasAttribute('data-hub-aria-widget'))widget.setAttribute('data-hub-aria-widget',crypto.randomUUID());
 const widgetToken=widget.getAttribute('data-hub-aria-widget');if([...document.querySelectorAll('[data-hub-aria-widget]')].filter(other=>other.getAttribute('data-hub-aria-widget')===widgetToken).length!==1)return fail();
 if(el.labels?.length!==1||!visible(el.labels[0]))return fail();
 const labelNode=el.labels[0].cloneNode(true);labelNode.querySelectorAll('input,select,textarea,button').forEach(node=>node.remove());const label=labelNode.textContent.trim();
 if(!label||label.length>2000||/\b(?:location|city|address|postal|zip|school|university|college)\b/i.test(label))return fail();
 const labelledBy=(el.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean),ariaLabel=el.getAttribute('aria-label');
 if(labelledBy.length&&(labelledBy.length!==1||labelledBy[0]!==el.labels[0].id||!uniqueId(el.labels[0]))||ariaLabel&&ariaLabel.trim()!==label)return fail();
 const displayed=[...container.querySelectorAll('.select__single-value')];if(displayed.length>1||displayed.some(node=>!visible(node)))return fail();
 const selectedLabel=displayed[0]?.innerText.trim()||null;
 const placeholders=container.querySelectorAll('.select__placeholder');if(!selectedLabel&&placeholders.length!==1||selectedLabel&&placeholders.length)return fail();
 const hidden=[...widget.querySelectorAll('input[type=hidden]')],questionNames=[el.name,el.id].filter(Boolean);
 // Reject unrelated fields using ownership/name metadata before reading any
 // hidden value. In particular a form nonce is never a choice companion.
 if(hidden.length>1||hidden.some(node=>node.parentElement!==widget||node.form!==form||node.disabled||!questionNames.includes(node.name)||node.name.length>200))return fail();
 if(hidden.some(node=>node.value.length>2000))return fail();
 const hiddenValues=hidden.map(node=>({name:node.name,value:node.value}));if(!selectedLabel&&hiddenValues.some(node=>node.value)||selectedLabel&&hiddenValues.some(node=>!node.name||!node.value))return fail();
 const expanded=el.getAttribute('aria-expanded');if(!['true','false'].includes(expanded))return fail();
 let listboxId=null,options=null;
 if(expanded==='true'){
  const ids=(el.getAttribute('aria-controls')||'').split(/\s+/).filter(Boolean);if(ids.length!==1)return fail();
  const listboxes=[...document.querySelectorAll('[id]')].filter(node=>node.id===ids[0]);if(listboxes.length!==1)return fail();
  const list=listboxes[0];if(list.tagName!=='DIV'||!list.classList.contains('select__menu-list')||!uniqueId(list)||list.getAttribute('role')!=='listbox'||list.getAttribute('aria-multiselectable')!=='false'||!visible(list)||!widget.contains(list)||list.closest('form')!==form||list.parentElement.closest(activatable)||list.querySelector('[aria-busy="true"],[role=progressbar],input,button,[contenteditable=true]'))return fail();
  const nodes=[...list.querySelectorAll('[role=option]')];if(nodes.length>2000)return fail();
  if(nodes.some(node=>node.tagName!=='DIV'||!node.classList.contains('select__option')||node.matches(activatable)||node.querySelector(activatable)||node.parentElement.closest(activatable)))return fail();
  options=nodes.filter(node=>node.closest('[role=listbox]')===list&&visible(node)&&node.getAttribute('aria-disabled')!=='true'&&!node.matches(':disabled')).map(node=>({id:node.id,label:node.innerText.trim(),valid:uniqueId(node)}));
  if(!options.length||options.length>500||options.some(option=>!option.valid||!option.label||option.label.length>1000||/^(?:create|add new|loading|no options|type to search)\b/i.test(option.label)))return fail();
  const normalized=options.map(option=>option.label.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase());if(new Set(normalized).size!==normalized.length||new Set(options.map(option=>option.id)).size!==options.length)return fail();
  options=options.map(({id,label})=>({id,label}));listboxId=list.id;
 }
 return {formToken,widgetToken,id:el.id,name:el.name||'',label,required:el.required||el.getAttribute('aria-required')==='true',links:[...el.labels[0].querySelectorAll('a[href]')].map(link=>link.href),expanded:expanded==='true',listboxId,options,selected:{label:selectedLabel,hiddenValues}};
}
async function state(page,selector,guard){
 if(await checked(guard,()=>page.locator(selector).count())!==1)throw hold('form_changed','The custom employer choice changed or became ambiguous.');
 const value=await checked(guard,()=>page.locator(selector).evaluate(capture));if(value.unsupported)throw unsupported();return value;
}
function binding(value){return {formToken:value.formToken,widgetToken:value.widgetToken,id:value.id,name:value.name,label:value.label,required:value.required,links:value.links,listboxId:value.listboxId,options:value.options};}
export function assertAriaChoiceUnchanged(expected,current){if(JSON.stringify(binding(expected))!==JSON.stringify(binding(current)))throw hold('form_changed','The employer custom question or its actual options changed. Review it before continuing.');}
async function open(page,selector,guard){
 const before=await state(page,selector,guard);
 if(!before.expanded)await checked(guard,()=>page.locator(selector).click({timeout:1500}));
 const first=await state(page,selector,guard);if(!first.expanded)throw unsupported();
 const second=await state(page,selector,guard);assertAriaChoiceUnchanged(first,second);if(JSON.stringify(first.selected)!==JSON.stringify(second.selected))throw hold('parser_changed_values','The employer changed the custom choice while it was being read.');return second;
}
async function close(page,selector,guard,opened){
 await checked(guard,()=>page.locator(selector).press('Escape',{timeout:1500}));
 const closed=await state(page,selector,guard);if(closed.expanded)throw unsupported();
 for(const key of ['formToken','widgetToken','id','name','label','required','links','selected'])if(JSON.stringify(closed[key])!==JSON.stringify(opened[key]))throw hold('form_changed','The employer choice changed as its menu closed.');return closed;
}
export async function inspectAriaChoice(page,selector,guard){const opened=await open(page,selector,guard);const closed=await close(page,selector,guard,opened);return {...opened,selected:closed.selected};}
export async function selectAriaChoice(page,selector,review,option,guard){
 const opened=await open(page,selector,guard);assertAriaChoiceUnchanged(review,opened);
 if(JSON.stringify(review.selected)!==JSON.stringify(opened.selected))throw hold('parser_changed_values','The employer changed the previously reviewed custom answer.');
 if(!opened.options.some(item=>item.id===option.id&&item.label===option.label))throw hold('form_changed','The selected employer option is no longer available.');
 await checked(guard,()=>page.locator(`div.select__option[role="option"][id="${option.id}"]`).click({timeout:1500}));
 const after=await state(page,selector,guard);if(normalize(after.selected.label)!==normalize(option.label))throw hold('form_changed','The employer custom choice did not show the exact selected option.');
 const verified=await inspectAriaChoice(page,selector,guard);assertAriaChoiceUnchanged(review,verified);
 if(normalize(verified.selected.label)!==normalize(option.label))throw hold('parser_changed_values','The employer changed the selected custom answer.');return verified;
}
export async function verifyAriaChoice(page,selector,review,guard){
 const current=await inspectAriaChoice(page,selector,guard);assertAriaChoiceUnchanged(review,current);
 if(JSON.stringify(current.selected)!==JSON.stringify(review.selected))throw hold('parser_changed_values','The employer changed a selected custom label or value. Review it before submission.');return current;
}
