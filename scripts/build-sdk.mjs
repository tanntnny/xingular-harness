import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
process.chdir(root)
const out = join(root, 'dist', 'sdk')
const config = ts.readConfigFile(join(root, 'tsconfig.sdk.json'), ts.sys.readFile)
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
const host = ts.createCompilerHost(parsed.options)
const program = ts.createProgram(parsed.fileNames, parsed.options, host)
const diagnostics = ts.getPreEmitDiagnostics(program)
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => '\n' }))
  process.exit(1)
}

// Keep one module graph for SDK and subpath imports. Only module specifiers are rewritten.
const extensions = context => source => {
  const factory = context.factory
  const specifier = node => {
    if (!node || !ts.isStringLiteral(node) || !node.text.startsWith('.')) return node
    const resolved = ts.resolveModuleName(node.text, source.fileName, parsed.options, host).resolvedModule
    if (resolved?.resolvedFileName.endsWith('.json')) {
      const emittedDir = dirname(join(out, relative(join(root, 'src'), source.fileName)))
      let path = relative(emittedDir, resolved.resolvedFileName.startsWith(join(root, 'src') + '/') ? join(out, relative(join(root, 'src'), resolved.resolvedFileName)) : resolve(dirname(source.fileName), node.text)).replaceAll('\\', '/')
      if (!path.startsWith('.')) path = `./${path}`
      return factory.createStringLiteral(path)
    }
    if (!resolved || !/\.(?:ts|tsx)$/.test(resolved.resolvedFileName) || resolved.resolvedFileName.endsWith('.d.ts')) return node
    let path = relative(dirname(source.fileName), resolved.resolvedFileName).replaceAll('\\', '/').replace(/\.(?:ts|tsx)$/, '.js')
    if (!path.startsWith('.')) path = `./${path}`
    return factory.createStringLiteral(path)
  }
  const visit = node => {
    if (ts.isImportDeclaration(node)) return factory.updateImportDeclaration(node, node.modifiers, node.importClause, specifier(node.moduleSpecifier), node.attributes)
    if (ts.isExportDeclaration(node)) return factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, specifier(node.moduleSpecifier), node.attributes)
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      return factory.updateImportTypeNode(node, factory.updateLiteralTypeNode(node.argument, specifier(node.argument.literal)), node.attributes, node.qualifier, node.typeArguments, node.isTypeOf)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) return factory.updateCallExpression(node, node.expression, node.typeArguments, [specifier(node.arguments[0])])
    return ts.visitEachChild(node, visit, context)
  }
  return ts.visitNode(source, visit)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const emitted = program.emit(undefined, undefined, undefined, undefined, { before: [extensions], afterDeclarations: [extensions] })
if (emitted.emitSkipped) throw new Error('SDK emission failed.')
// Ambient declarations used by public types must also be available to consumers.
for (const file of parsed.fileNames.filter(file => file.endsWith('.d.ts'))) {
  const target = join(out, relative(join(root, 'src'), file))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, readFileSync(file))
}
if (!existsSync(join(out, 'index.js')) || !existsSync(join(out, 'index.d.ts'))) throw new Error('SDK entrypoints are missing.')
console.log('Built Node ESM SDK and declarations in dist/sdk.')
