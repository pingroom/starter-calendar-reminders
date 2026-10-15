import { loadConfig, loadEnvironment } from '../src/config.mjs';
import { resolveReminder } from '../src/reminders.mjs';

try {
  loadEnvironment();
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error('Use npm run resolve -- <reminder ID> confirmed|abandoned.');
  console.log(JSON.stringify(await resolveReminder(await loadConfig(), ...args), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
