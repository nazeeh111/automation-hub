import { homedir } from 'node:os';
import path from 'node:path';
// Keep large version-matched browser binaries outside synced project folders.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(homedir(),'Library','Application Support','Automation Hub','runtime','browsers');
