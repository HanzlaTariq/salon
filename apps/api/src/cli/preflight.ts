import { parseEnv } from '../config/env';
import { preflightChecks } from '../config/preflight';

/**
 * Checks the production environment BEFORE you start or update the API. Prints variable names only, never values.
 * Exit code 1 = do not deploy.
 *   npm run preflight
 */
function main(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    parseEnv(process.env);
  } catch (e) {
    errors.push(...(e instanceof Error ? e.message : String(e)).split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter((l) => l && !l.startsWith('Invalid environment configuration')));
  }
  const extra = preflightChecks(process.env);
  errors.push(...extra.errors);
  warnings.push(...extra.warnings);

  /* eslint-disable no-console */
  for (const w of warnings) console.log(`WARN   ${w}`);
  for (const e of errors) console.log(`ERROR  ${e}`);
  if (errors.length > 0) {
    console.log(`\nPreflight FAILED: ${errors.length} error(s), ${warnings.length} warning(s). Do not deploy.`);
    process.exit(1);
  }
  console.log(`Preflight passed: 0 errors, ${warnings.length} warning(s).`);
}

main();
