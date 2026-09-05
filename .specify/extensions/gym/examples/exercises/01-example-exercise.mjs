// Example graded exercise. Replace with a real load test for YOUR software.
// The runner waits for a `.submitted` marker in the sandbox, then calls
// `evaluate(sandbox)` and treats `{ pass: true }` as cleared.
import fs from 'node:fs';

export default {
  id: 'ex-1',
  name: 'Build a valid report',
  muscle: 'can produce real output with the software',
  brief:
    'In the sandbox, create report.json whose body is a JSON object with a numeric ' +
    '"total" field, then leave a .submitted marker. The runner grades what you built.',
  evaluate(sandbox) {
    const p = sandbox + '/report.json';
    if (!fs.existsSync(p)) return { pass: false, notes: 'report.json missing in sandbox' };
    let data;
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return { pass: false, notes: 'report.json is not valid JSON' };
    }
    if (typeof data.total !== 'number') {
      return { pass: false, notes: 'report.json missing numeric "total"' };
    }
    return { pass: true, notes: `valid report with total=${data.total}` };
  },
};
