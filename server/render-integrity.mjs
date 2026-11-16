// Compare the whole ordered text, never a bag of words or a loss allowance.
// Only presentation differences are normalized; facts, negations, punctuation
// inside tokens and their ordering must remain source-supported.
const clean=value=>String(value??'').normalize('NFKC').replace(/^\uFEFF/,'').replace(/\u00ad/g,'').replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"').replace(/[\u2010\u2011]/g,'-');
const bullets=/^[ \t]*[•●○◦▪▫‣⁃\uF0B7\uF0A7\uF0D8](?:[ \t]+|$)/gm;
function presentation(value,{markdown=false}={}){
 let text=clean(value).replace(bullets,'');
 if(markdown)text=text.replace(/^[ \t]*#{1,6}[ \t]+/gm,'').replace(/^[ \t]*[-*][ \t]+/gm,'');
 return text;
}
const spaces=value=>value.replace(/\s+/gu,' ').trim();
export function assertRenderedText(expected,actual,{sourceMime=''}={}){
 const source=presentation(expected,{markdown:['text/plain','text/markdown'].includes(sourceMime)}),wanted=spaces(source);
 // A hard hyphen may end a physical PDF line. Join only when the retained
 // source contains that exact hyphenated token, keeping the hyphen itself.
 const rendered=presentation(actual).replace(/(\S+-)[ \t]*(?:\r?\n[ \t]*)+(\S+)/g,(whole,left,right)=>wanted.includes(left+right)?left+right:whole)
  // Some PDF fonts split a nonbreaking hyphen into its own text item. Remove
  // only those added horizontal spaces when the exact source token agrees.
  .replace(/(\S+)[ \t]+-[ \t]+(\S+)/g,(whole,left,right)=>wanted.includes(left+'-'+right)?left+'-'+right:whole);
 if(wanted!==spaces(rendered))throw Object.assign(new Error('The rendered document changes source text. Review the retained original and preview, or import a matching verified PDF.'),{code:'resume_review',renderCode:'render_integrity_review',status:409});
 return {text:true};
}

