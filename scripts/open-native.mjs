import {spawn} from 'node:child_process';
import path from 'node:path';
import {homedir} from 'node:os';
if(process.platform!=='darwin')throw new Error('The native app opens on macOS. Use npm start for the browser workspace.');
const child=spawn('/usr/bin/open',[path.join(homedir(),'Applications','Automation Hub.app')],{stdio:'ignore'});
child.on('error',()=>{console.error('The Mac app could not open. Run npm run app:build to install or restore it.');process.exitCode=1;});
child.on('exit',code=>{if(code){console.error('The Mac app could not open. Check its installation; no alternate route was attempted.');process.exitCode=1;}});
