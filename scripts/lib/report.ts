/** Collects validation results per rule and prints them grouped. */

export type Status = 'pass' | 'fail' | 'warn' | 'skip';

interface Item {
  status: Status;
  message: string;
}

/** Results of one rule. Rules call pass/fail/warn/skip; nothing else. */
export class RuleLog {
  readonly items: Item[] = [];

  constructor(
    readonly id: string,
    readonly title: string,
  ) {}

  pass(message: string): void {
    this.items.push({ status: 'pass', message });
  }

  fail(message: string): void {
    this.items.push({ status: 'fail', message });
  }

  warn(message: string): void {
    this.items.push({ status: 'warn', message });
  }

  skip(message: string): void {
    this.items.push({ status: 'skip', message });
  }

  /** Records a pass when `failures` is empty, otherwise one failure per entry. */
  expectNone(failures: readonly string[], passMessage: string): void {
    if (failures.length === 0) this.pass(passMessage);
    else for (const f of failures) this.fail(f);
  }

  count(status: Status): number {
    return this.items.filter((i) => i.status === status).length;
  }

  get outcome(): Status {
    if (this.count('fail') > 0) return 'fail';
    if (this.count('warn') > 0) return 'warn';
    if (this.count('pass') > 0) return 'pass';
    return 'skip';
  }
}

const LABEL: Record<Status, string> = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP' };

export class Report {
  readonly rules: RuleLog[] = [];

  rule(id: string, title: string): RuleLog {
    const log = new RuleLog(id, title);
    this.rules.push(log);
    return log;
  }

  get failed(): RuleLog[] {
    return this.rules.filter((r) => r.outcome === 'fail');
  }

  print(): void {
    for (const rule of this.rules) {
      console.log(`\n[${rule.id}] ${rule.title}: ${LABEL[rule.outcome]}`);
      for (const item of rule.items) console.log(`  ${LABEL[item.status]}  ${item.message}`);
    }
    const failed = this.failed;
    const summary = this.rules.map((r) => `${r.id}=${LABEL[r.outcome]}`).join(' ');
    console.log(`\nSummary: ${summary}`);
    console.log(
      failed.length === 0
        ? 'validate: OK'
        : `validate: ${failed.length} rule(s) failing (${failed.map((r) => r.id).join(', ')})`,
    );
  }
}
