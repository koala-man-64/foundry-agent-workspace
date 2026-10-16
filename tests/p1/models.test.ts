import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

function generateModels(): string {
  const program = ts.createProgram(['packages/protocol/src/index.ts'], { strict: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile('packages/protocol/src/index.ts')!;
  const identifier = (value: string) => value.split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => part[0]!.toUpperCase() + part.slice(1)).join('');
  const definitions = new Map<string, string>();
  const names = new Map<ts.Type, string>();
  const unique = (hint: string) => { let name = identifier(hint); let suffix = 2; while (definitions.has(name)) name = identifier(hint) + suffix++; definitions.set(name, ''); return name; };

  function typeName(type: ts.Type, hint: string): string {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null)) return 'object?';
    if (type.flags & ts.TypeFlags.StringLike) return 'string';
    if (type.flags & ts.TypeFlags.NumberLike) return 'double';
    if (type.flags & ts.TypeFlags.BooleanLike) return 'bool';
    if (type.isUnion()) {
      const present = type.types.filter(t => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
      const nullable = present.length !== type.types.filter(t => !(t.flags & ts.TypeFlags.Undefined)).length;
      if (present.length === 0) return 'object?';
      const primitive = present.every(t => t.flags & ts.TypeFlags.StringLike) ? 'string' : present.every(t => t.flags & ts.TypeFlags.NumberLike) ? 'double' : present.every(t => t.flags & ts.TypeFlags.BooleanLike) ? 'bool' : undefined;
      if (primitive) return primitive + (nullable ? '?' : '');
      if (present.length === 1) return typeName(present[0]!, hint) + (nullable ? '?' : '');
      if (present.every(t => t.flags & ts.TypeFlags.Object)) {
        const known = names.get(type); if (known) return known + (nullable ? '?' : '');
        const name = unique(hint); names.set(type, name);
        definitions.set(name, `public abstract record ${name} : IWireModel\n{\n    public abstract Dictionary<string, object?> ToWire();\n}`);
        present.forEach((variant, i) => model(variant, `${name}Variant${i + 1}`, name));
        return name + (nullable ? '?' : '');
      }
      return 'object?'; // Explicit heterogeneous/opaque JSON, never interpreted as authority.
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const elements = checker.getTypeArguments(type as ts.TypeReference);
      return `IReadOnlyList<${elements.length === 1 ? typeName(elements[0]!, hint + 'Item') : 'object?'}>`;
    }
    const indexed = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    if (indexed) return `IReadOnlyDictionary<string, ${typeName(indexed, hint + 'Value')}>`;
    return model(type, hint);
  }

  function model(type: ts.Type, hint: string, parent?: string): string {
    const known = names.get(type); if (known && !parent) return known;
    const name = unique(hint); if (!parent) names.set(type, name);
    const fields = checker.getPropertiesOfType(type).map(property => {
      const fieldType = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? source);
      const optional = !!(property.flags & ts.SymbolFlags.Optional) || fieldType.isUnion() && fieldType.types.some(t => !!(t.flags & ts.TypeFlags.Undefined));
      const csType = typeName(fieldType, name + identifier(property.name));
      return { wire: property.name, name: identifier(property.name), type: optional ? `Specified<${csType}>` : csType, optional };
    });
    const properties = fields.map(field => `    public ${field.optional ? '' : 'required '}${field.type} ${field.name} { get; init; }`).join('\n');
    const values = fields.map(field => `        [${JSON.stringify(field.wire)}] = ${field.optional ? `${field.name}.IsPresent ? (object?)${field.name}.Value : Undefined.Value` : field.name}`).join(',\n');
    definitions.set(name, `public sealed record ${name} : ${parent ?? 'IWireModel'}\n{\n${properties}\n    public ${parent ? 'override ' : ''}Dictionary<string, object?> ToWire() => new()\n    {\n${values}\n    };\n}`);
    return name;
  }

  type Rule = { type: string; shape?: Record<string, Rule>; innerType?: Rule; in?: Rule; options?: Rule[]; element?: Rule; valueType?: Rule; values?: unknown[] };
  function grammarType(rule: Rule, hint: string, parent?: string): string {
    if (rule.type === 'optional' || rule.type === 'default' || rule.type === 'prefault' || rule.type === 'nullable') return grammarType(rule.innerType!, hint) + (rule.type === 'nullable' ? '?' : '');
    if (rule.type === 'pipe') return grammarType(rule.in!, hint);
    if (rule.type === 'string' || rule.type === 'enum') return 'string';
    if (rule.type === 'number') return 'double';
    if (rule.type === 'boolean') return 'bool';
    if (rule.type === 'literal') return rule.values![0] === null ? 'object?' : typeof rule.values![0] === 'string' ? 'string' : typeof rule.values![0] === 'boolean' ? 'bool' : 'double';
    if (rule.type === 'array') return `IReadOnlyList<${grammarType(rule.element!, hint + 'Item')}>`;
    if (rule.type === 'record') return `IReadOnlyDictionary<string, ${grammarType(rule.valueType!, hint + 'Value')}>`;
    if (rule.type === 'union') {
      if (!rule.options!.every(option => option.type === 'object')) {
        const types = new Set(rule.options!.map(option => grammarType(option, hint + 'Value')));
        return types.size === 1 ? [...types][0]! : 'object?';
      }
      const name = unique(hint);
      definitions.set(name, `public abstract record ${name} : IWireModel\n{\n    public abstract Dictionary<string, object?> ToWire();\n}`);
      rule.options!.forEach((option, index) => grammarType(option, name + 'Variant' + (index + 1), name));
      return name;
    }
    if (rule.type !== 'object') return 'object?';
    const name = unique(hint);
    const fields = Object.entries(rule.shape!).map(([wire, value]) => {
      const optional = ['optional', 'default', 'prefault'].includes(value.type);
      const csType = grammarType(value, name + identifier(wire));
      return { wire, name: identifier(wire), type: optional ? `Specified<${csType}>` : csType, optional };
    });
    const properties = fields.map(field => `    public ${field.optional ? '' : 'required '}${field.type} ${field.name} { get; init; }`).join('\n');
    const values = fields.map(field => `        [${JSON.stringify(field.wire)}] = ${field.optional ? `${field.name}.IsPresent ? (object?)${field.name}.Value : Undefined.Value` : field.name}`).join(',\n');
    definitions.set(name, `public sealed record ${name} : ${parent ?? 'IWireModel'}\n{\n${properties}\n    public ${parent ? 'override ' : ''}Dictionary<string, object?> ToWire() => new()\n    {\n${values}\n    };\n}`);
    return name;
  }
  const contracts = Object.entries(JSON.parse(readFileSync('src/Foundry.Protocol/Contracts.json', 'utf8')) as Record<string, Rule>).map(([name, rule]) => [name, grammarType(rule, identifier(name) + 'Input')] as const);
  const api = source.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'DesktopApi')!;
  const invoke = checker.getTypeAtLocation(api).getProperty('invoke')!;
  const results = new Map<string, string>();
  for (const signature of checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(invoke, source), ts.SignatureKind.Call)) {
    const methods = checker.getTypeOfSymbolAtLocation(signature.parameters[0]!, source);
    const result = checker.getTypeArguments(checker.getReturnTypeOfSignature(signature) as ts.TypeReference)[0]!;
    for (const method of methods.isUnion() ? methods.types : [methods]) {
      if (!method.isStringLiteral()) throw new Error('Unbounded RPC signature');
      results.set(method.value, typeName(result, identifier(method.value) + 'Result'));
    }
  }
  expect(results.size).toBe(89);
  const mappings = contracts.map(([contract, type]) => `        [${JSON.stringify(contract)}] = typeof(${type.replace(/\?/g, '')})`).join(',\n');
  const resultMappings = [...results].map(([method, type]) => `        [${JSON.stringify(method)}] = typeof(${type.replace(/\?/g, '')})`).join(',\n');
  return '// Generated from the frozen TypeScript contract types. Regenerate explicitly with P1_WRITE_MODELS=1.\n#nullable enable\nnamespace Foundry.Protocol.Models;\n\n' + [...definitions.values()].join('\n\n') + `\n\npublic static class ContractModelTypes\n{\n    public static IReadOnlyDictionary<string, Type> Inputs { get; } = new Dictionary<string, Type>\n    {\n${mappings}\n    };\n    public static IReadOnlyDictionary<string, Type> Results { get; } = new Dictionary<string, Type>\n    {\n${resultMappings}\n    };\n}\n`;
}

it('pins typed models for every input contract and every RPC result', () => {
  const generated = generateModels();
  const path = 'src/Foundry.Protocol/Models.g.cs';
  if (process.env.P1_WRITE_MODELS === '1') writeFileSync(path, generated);
  expect(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).toBe(generated);
});
