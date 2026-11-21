import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Tokenizes C# source into code vs comments/strings while flagging C# 6+ interpolated strings ($"...").
 * Stripping normal string/char literals and comments prevents false positives inside literals/docs.
 */
function stripLiteralsAndComments(source) {
  const out = [];
  const violations = [];
  let line = 1;
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '\n') {
      line++;
      out.push(ch);
      i++;
      continue;
    }

    // Line comment
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') { line++; out.push('\n'); }
        i++;
      }
      i += 2;
      out.push(' ');
      continue;
    }

    // C# 6+ interpolated string ($"...", $@"...", @$"...")
    if ((ch === '$' && (next === '"' || (next === '@' && source[i + 2] === '"'))) ||
        (ch === '@' && next === '$' && source[i + 2] === '"')) {
      violations.push({ line, rule: 'interpolated string ($"...")' });
      i += next === '@' || ch === '@' ? 3 : 2;
      const verbatim = next === '@' || ch === '@';
      while (i < source.length) {
        if (verbatim) {
          if (source[i] === '"' && source[i + 1] === '"') { i += 2; continue; }
          if (source[i] === '"') { i++; break; }
        } else {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '"') { i++; break; }
        }
        if (source[i] === '\n') { line++; out.push('\n'); }
        i++;
      }
      out.push('""');
      continue;
    }

    // Verbatim string literal @"..."
    if (ch === '@' && next === '"') {
      i += 2;
      while (i < source.length) {
        if (source[i] === '"' && source[i + 1] === '"') { i += 2; continue; }
        if (source[i] === '"') { i++; break; }
        if (source[i] === '\n') { line++; out.push('\n'); }
        i++;
      }
      out.push('""');
      continue;
    }

    // Regular string literal "..."
    if (ch === '"') {
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '"') { i++; break; }
        if (source[i] === '\n') { line++; out.push('\n'); }
        i++;
      }
      out.push('""');
      continue;
    }

    // Char literal '...'
    if (ch === "'") {
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === "'") { i++; break; }
        i++;
      }
      out.push("''");
      continue;
    }

    out.push(ch);
    i++;
  }

  return { code: out.join(''), violations };
}

export function findCSharp6PlusViolations(source) {
  const { code, violations } = stripLiteralsAndComments(source);
  const lineAt = index => code.slice(0, index).split('\n').length;

  const patterns = [
    { rule: 'null-conditional operator (?.)', regex: /\?\./g },
    { rule: 'null-conditional indexer (?[)', regex: /\?\[/g },
    { rule: 'null-coalescing assignment (??=)', regex: /\?\?=/g },
    { rule: 'nameof(...) operator', regex: /\bnameof\s*\(/g },
    { rule: 'using static directive', regex: /\busing\s+static\b/g },
    { rule: 'inline out var declaration', regex: /\bout\s+var\s+[A-Za-z_][A-Za-z0-9_]*/g },
    { rule: 'auto-property initializer', regex: /\{\s*(?:get|set)\s*;\s*(?:(?:private|protected|internal)\s+)?(?:get|set)?\s*;?\s*\}\s*=/g },
    { rule: 'switch expression', regex: /\bswitch\s*\{/g },
    { rule: 'pattern matching is-expression', regex: /\bis\s+(?:not\b|(?!null\b|true\b|false\b)[A-Za-z_][A-Za-z0-9_.<>]*\s+[a-z_][A-Za-z0-9_]*\b)/g },
    { rule: 'expression-bodied member', regex: /(?:^|[;{}])\s*(?:(?:public|private|protected|internal|static|virtual|override|sealed|new|async|extern)\s+)*[A-Za-z_][A-Za-z0-9_<>\[\],\s]*\s+[A-Za-z_][A-Za-z0-9_]*(?:\([^;{}]*\))?\s*=>/gm },
  ];

  for (const { rule, regex } of patterns) {
    for (const match of code.matchAll(regex)) {
      violations.push({ line: lineAt(match.index), rule, snippet: match[0].trim() });
    }
  }

  // Detect C# 7+ inline `out Type name` at call sites while permitting C# 1-5 formal `out Type name` parameters.
  const outRegex = /\bout\s+(?:int|uint|long|ulong|short|ushort|byte|sbyte|bool|float|double|decimal|char|string|object|IntPtr|UIntPtr|[A-Z][A-Za-z0-9_<>]*)\s+[A-Za-z_][A-Za-z0-9_]*/g;
  for (const match of code.matchAll(outRegex)) {
    // Walk backwards to find the enclosing `(` of this parameter/argument list.
    let depth = 0;
    let openParen = -1;
    for (let j = match.index - 1; j >= 0; j--) {
      if (code[j] === ')') depth++;
      else if (code[j] === '(') {
        if (depth === 0) { openParen = j; break; }
        depth--;
      }
    }
    // Look backwards from openParen to the previous statement/member boundary (`;`, `{`, `}`).
    let boundary = 0;
    for (let j = openParen - 1; j >= 0; j--) {
      if (code[j] === ';' || code[j] === '{' || code[j] === '}') { boundary = j + 1; break; }
    }
    const header = code.slice(boundary, openParen).replace(/\[[^\]]*\]/g, ' ').trim();
    // A formal parameter declaration has modifiers/return type before the method/delegate name
    // (at least 2 tokens, no dots, no `new`/`return`/`=`/`(`/`,`/`:`).
    const isSignature = !/[.=(),?:]|(?:\b(?:new|return|if|while|for|else|case|throw)\b)/.test(header)
      && /^(?:[A-Za-z_][A-Za-z0-9_<>\[\]]*\s+)+[A-Za-z_][A-Za-z0-9_]*$/.test(header);
    if (!isSignature) {
      violations.push({ line: lineAt(match.index), rule: 'inline out variable declaration', snippet: match[0].trim() });
    }
  }
  return violations;
}

test('every C# source file in apps/windows/src uses strict C# 5 syntax for .NET Framework 4.8 csc.exe', () => {
  const srcDir = resolve('src');
  const files = readdirSync(srcDir).filter(name => name.endsWith('.cs')).sort();
  assert.ok(files.length >= 6, `Expected C# files in ${srcDir}`);
  for (const file of files) {
    const content = readFileSync(join(srcDir, file), 'utf8');
    const violations = findCSharp6PlusViolations(content);
    assert.deepEqual(violations, [], `${file} contains forbidden C# 6+ syntax: ${JSON.stringify(violations)}`);
  }
});

test('C# 5 static validator catches forbidden C# 6+ constructs while ignoring comments and strings', () => {
  const forbidden = [
    'var s = $"hello {x}";',
    'var y = a?.Prop;',
    'var z = arr?[0];',
    'x ??= 1;',
    'var n = nameof(Foo);',
    'using static System.Math;',
    'if (Int32.TryParse(s, out int v)) {}',
    'TryGetValue(k, out var val);',
    'Method(out int x);',
    'new Mutex(true, "x", out bool created);',
    'public int Count { get; set; } = 1;',
    'var r = x switch { 1 => "a", _ => "b" };',
    'if (obj is string text) {}',
    'public int Value => 42;',
    'static string Name(int id) => id.ToString();',
  ];
  for (const line of forbidden) {
    assert.ok(findCSharp6PlusViolations(line).length > 0, `Expected violation for: ${line}`);
  }

  const validCSharp5 = `
    // comment with $"" and ?. and nameof(x) and out int v
    class Demo {
      public int Count { get; set; }
      string msg = "literal ?. nameof(x) $" + String.Format("{0}", 1);
      Func<int, int> fn = x => x + 1;
      void Parse(string s) {
        int v;
        if (Int32.TryParse(s, out v) && s is string) {}
      }
    }
  `;
  assert.deepEqual(findCSharp6PlusViolations(validCSharp5), []);
});
