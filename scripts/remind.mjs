import { loadConfig, loadConnection, loadEnvironment } from '../src/config.mjs';
import { runReminders } from '../src/reminders.mjs';

try {
  loadEnvironment();
  const result = await runReminders(await loadConfig(), await loadConnection());
  console.log(JSON.stringify(result, null, 2));
  if (result.unresolved.length) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
