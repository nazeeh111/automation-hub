import {createServer} from 'node:http';
const safe=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function employerFixture() {
 let submissions=0,lastBody='';
 const server=createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');
  res.setHeader('content-type','text/html; charset=utf-8');
  if(u.pathname==='/submit') {lastBody='';for await(const chunk of req)lastBody+=chunk.toString('utf8');submissions++;res.end('ok');return;}
  if(u.pathname==='/receipt') {res.end(`<h1>Application received</h1><p>Thank you for applying. Engineering intern. ${u.searchParams.get('mode')==='mismatch'?'Other company':'Example Labs'}. synthetic@example.test</p><div data-confirmation-id="fixture-${submissions}">Fixture reference</div>`);return;}
  const mode=u.searchParams.get('mode')||'normal';
  res.end(`<!doctype html><html><head><title>Engineering intern</title></head><body>
  ${['expired','dateonly'].includes(mode)?`<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',title:'Engineering intern',hiringOrganization:{name:'Example Labs'},url:`http://127.0.0.1:${server.address().port}/jobs/fixture`,validThrough:mode==='expired'?'2000-01-01T00:00:00Z':'2000-01-01'})}</script>`:''}<h1>${mode==='unicode-identity'?'设计实习生':'Engineering intern'}</h1><p data-employer>Example Labs</p><p>This synthetic internship involves testing application forms. JavaScript and Python experience preferred. This controlled fixture never contacts an employer.</p>
  ${mode==='account'?'<label>Password<input type="password" aria-label="Password"></label>':mode==='captcha'?'<p>Verify you are human: CAPTCHA challenge</p>':''}
  <form id="application"><input type="hidden" name="tracking" value="unchanged-tracking"><input disabled value="disabled-value">
   <fieldset id="first"><legend>Contact details</legend>
    <label>Full name<input id="full-name" name="name" required></label>
    <label>Email<input id="email" name="email" type="email" required></label>
    <label>Resume<input id="resume" name="resume" type="file" ${mode==='pdfonly'?'accept=".pdf,application/pdf"':''} required></label>
    <button type="button" id="next">Next</button>
   </fieldset>
   <fieldset id="second" hidden><legend>Availability</legend>
    <label>Available start date<select id="start" name="start" required><option value="">Choose</option><option>June</option><option>July</option></select></label>
    <label><input id="consent" type="checkbox" required>I agree to the employer privacy notice</label>${['select-unicode','select-duplicate'].includes(mode)?'<label>Preferred language<select name="language" required><option value="">Choose</option><option value="en">English</option><option value="ja">日本語</option><option value="cpp">C++</option><option value="cs">C#</option><option value="disabled" disabled>禁止</option></select></label>':''}${mode==='radio-consent-change'?'<fieldset><legend>I agree to employer terms</legend><a id="terms-link" href="/terms-v1">Read terms</a><label><input type="radio" name="consent-choice" value="yes" required>Yes</label><label><input type="radio" name="consent-choice" value="no">No</label></fieldset>':''}${['radio','radio-parser','radio-optional','radio-ambiguous'].includes(mode)?`<fieldset>${mode==='radio-ambiguous'?'':'<legend>Preferred language</legend>'}<label><input type="radio" name="language" value="en" ${mode==='radio-optional'?'checked':'required'}>English</label><label><input type="radio" name="language" value="ja">日本語</label></fieldset>`:''}
    ${mode==='document'?'<label>Cover letter<input name="cover-letter" type="file" accept=".txt,text/plain" required></label>':''}${mode==='manual-essay'?'<p>Do not use AI-generated responses. Write answers independently in your own words.</p>':''}${['essay','manual-essay'].includes(mode)?'<label>Describe a prototype you built<textarea required></textarea></label>':''}
    <button type="submit" ${mode==='disabled'?'disabled':''}>Submit application</button>
   </fieldset>
  </form>
  <script>
   next.onclick=()=>{first.hidden=true;second.hidden=false;${mode==='identity'?"history.replaceState({},'', '/jobs/other');":''}${mode==='employer'?"document.querySelector('[data-employer]').textContent='Other Company';":''}};
   resume.onchange=()=>{${mode==='parser'?'setTimeout(()=>{document.getElementById("full-name").value="Wrong Parser Name"},20);':''}${mode==='attachment'?'const d=new DataTransfer();d.items.add(new File(["changed document"],"other.pdf",{type:"application/pdf"}));resume.files=d.files;':''}};
   ${mode==='radio-parser'?`document.querySelector('input[value=ja]').onchange=()=>setTimeout(()=>{document.querySelector('input[value=en]').checked=true},20);`:''}${mode==='select-duplicate'?`document.querySelector('select[name=language] option[value=cpp]').textContent='日本語';`:''}${mode==='radio-consent-change'?`document.querySelector('input[name=consent-choice][value=yes]').onchange=()=>setTimeout(()=>{document.getElementById('terms-link').href='/terms-v2'},20);`:''}application.onsubmit=async e=>{e.preventDefault();await fetch('/submit',{method:'POST',body:new FormData(application)});location.href='/receipt?mode=${safe(mode)}'};
  </script></body></html>`);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {url:`http://127.0.0.1:${server.address().port}/jobs/fixture`,submissions:()=>submissions,lastBody:()=>lastBody,close:()=>new Promise(resolve=>server.close(resolve))};
}
