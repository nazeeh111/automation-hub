import path from 'node:path';

const messages={
 HUB_DATA_DIRECTORY:'Set HUB_DATA_DIR to an absolute private directory.',
 HUB_CAPABILITY_PATH:'Use an absolute, accessible path for the configured external tool or browser directory. Correct the explicit setting before retrying.',
 HUB_PORT_IN_USE:'The requested local port is in use. Stop the identified hub or choose an unused HUB_PORT explicitly.',
 HUB_PORT_INVALID:'Set HUB_PORT to a whole number from 0 to 65535.',
 NATIVE_OPERATION:'Choose a supported native operation.',
 NATIVE_CONFIGURATION:'The captured native configuration is invalid. Rebuild the app after correcting its local tool settings.',
 NATIVE_BACKEND_START:'The background worker exited before opening. Check the local installation and rebuild if necessary.',
 NATIVE_BACKEND_TIMEOUT:'The background worker did not become ready in time. Check the identified process before reconnecting.',
 LOCAL_SHUTDOWN_NOT_RUNNING:'No running worker was identified. Shutdown was not verified; inspect the current process before restoring files.',
 LOCAL_SHUTDOWN_TIMEOUT:'Shutdown is not yet verified. Keep current data in place and wait for the identified worker to finish.',
 LOCAL_SHUTDOWN_CHANGED:'Worker ownership changed. The replacement was left untouched; do not restore files until the current worker is identified and stopped.',
 LOCAL_LAUNCH_MODE:'Private launch permissions are unsafe. Inspect the owned directory and documented private modes.',
 LOCAL_LAUNCH_OWNER:'Private launch ownership was rejected. Preserve the existing entries and inspect their owner before repair.',
 LOCAL_LAUNCH_PATH:'The private control path is invalid or too long. Inspect the explicit data directory before retrying.',
 LOCAL_LAUNCH_BUSY:'The identified control owner is still running. Stop that worker before recovery.',
 LOCAL_LAUNCH_LEASE:'The worker lease is required before stale control recovery.',
 LOCAL_LAUNCH_DENIED:'Process ownership could not be verified. Inspect the native permission boundary.',
 LOCAL_LAUNCH_PROTOCOL:'The identified worker refused the private request. Check its version and ownership before retrying.',
 LOCAL_LAUNCH_TIMEOUT:'The identified worker did not answer. Check its process before retrying.',
 LOCAL_LAUNCH_REFUSED:'The private request was refused. Check the existing process and private launch permissions.',
 NATIVE_OPEN_FAILED:'The system browser could not open the private workspace. Check the native browser-opening permission.',
 EACCES:'Native access was denied. Correct the specific permission through the operating system before retrying.',
 EPERM:'Native access was denied. Correct the specific permission through the operating system before retrying.',
 UNSUPPORTED_PLATFORM:'Private local launch requires the supported macOS Unix user boundary.'
};
export function startupCode(error){
 if(error?.code==='EADDRINUSE')return 'HUB_PORT_IN_USE';
 if(Object.hasOwn(messages,error?.code))return error.code;
 return 'NATIVE_BACKEND_START';
}
export function startupMessage(error){const code=startupCode(error);return `${code}: ${messages[code]} No alternate access route was attempted.`;}
export function startupFault(code){return Object.assign(new Error(messages[code]||messages.NATIVE_BACKEND_START),{code});}
export function absoluteSetting(value){
 if(typeof value!=='string'||!value||value.length>4096||/[\x00-\x1f\x7f]/.test(value)||!path.isAbsolute(value))throw startupFault('HUB_CAPABILITY_PATH');
 return value;
}
export function validateStartupEnvironment(env=process.env){
 if(env.HUB_DATA_DIR!==undefined){try{absoluteSetting(env.HUB_DATA_DIR);}catch{throw startupFault('HUB_DATA_DIRECTORY');}}
 if(env.HUB_PORT!==undefined&&(!/^\d{1,5}$/.test(env.HUB_PORT)||Number(env.HUB_PORT)>65535))throw startupFault('HUB_PORT_INVALID');
 for(const key of ['HUB_CODEX_BIN','HUB_SOFFICE_BIN','PLAYWRIGHT_BROWSERS_PATH'])if(env[key]!==undefined)absoluteSetting(env[key]);
}
