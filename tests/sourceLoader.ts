import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = new URL("../src/", import.meta.url).href;
const vendorRoot = new URL("../src/vendor/", import.meta.url).href;
const viteEntrypoints = new Set([
  new URL("../src/addons/deliverables/api/client.ts", import.meta.url).href,
  new URL("../src/addons/deliverables/composables/embeddedSession.ts", import.meta.url).href,
]);
const config = ts.readConfigFile(`${root}tsconfig.json`, ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;

// Native module loading keeps these integration tests visible to Node coverage.
export function installSourceLoader() {
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith("file:")) {
        const resolved = ts.resolveModuleName(specifier, fileURLToPath(context.parentURL), options, ts.sys).resolvedModule;
        if (resolved) {
          const url = pathToFileURL(resolved.resolvedFileName).href;
          if (url.startsWith(sourceRoot) && url.endsWith(".ts")) return { url, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!viteEntrypoints.has(url) && !(url.startsWith(vendorRoot) && url.endsWith(".ts"))) {
        return nextLoad(url, context);
      }
      const result = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        fileName: fileURLToPath(url),
        compilerOptions: {
          ...options, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
          sourceMap: false, inlineSourceMap: true, inlineSources: true,
        },
        transformers: { before: [(transformContext) => {
          const visit: ts.Visitor = (node) => {
            if (ts.isPropertyAccessExpression(node) && node.name.text === "env" &&
                ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
              return ts.factory.createObjectLiteralExpression();
            }
            return ts.visitEachChild(node, visit, transformContext);
          };
          return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
        }] },
      });
      return { format: "module", source: result.outputText, shortCircuit: true };
    },
  });
}
