import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, defineComponent, h, nextTick, reactive } from "vue";
import ts from "typescript";
import { installSourceLoader } from "./sourceLoader.ts";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await nextTick();
}

export class DocumentHost {
  innerHTML = "";
  ownerDocument = { createElement: () => new DocumentHost() };
  querySelectorAll() { return []; }
  replaceChildren() { this.innerHTML = ""; }
}

export const fixtures = {
  api: {} as Record<string, (...args: any[]) => any>,
  sanitize: (html: string) => html,
  parseMarkdown: async (text: string) => text,
  renderDocx: async (_buffer: ArrayBuffer, host: DocumentHost, _styles: unknown, _options: unknown) => {
    host.innerHTML = "<p>Document fixture</p>";
  },
};

// Compile the real script setup; Vue runs its watchers and lifecycle hooks.
// API/renderers are controlled boundaries, not copied component implementations.
export function installComponentLoader() {
  const sourceLoader = installSourceLoader();
  Object.assign(globalThis, { __deliverablesComponentFixtures: fixtures });
  const componentRoot = new URL("../src/addons/deliverables/components/", import.meta.url);
  const mocks: Record<string, string> = {
    "@/addons/deliverables/api/client": Object.keys({
      listDeliverables: 0, getDownloadUrl: 0, deleteDeliverable: 0, cloneDeliverable: 0,
      createUpload: 0, uploadBytes: 0, sha256Hex: 0, completeUpload: 0,
      createAppLink: 0, importDeliverable: 0,
    }).map((name) => `export const ${name} = (...args) => globalThis.__deliverablesComponentFixtures.api.${name}(...args);`).join("\n"),
    "vue-i18n": "export const useI18n = () => ({ t: (key) => key });",
    dompurify: "export default { sanitize: (...args) => globalThis.__deliverablesComponentFixtures.sanitize(...args) };",
    marked: "export const marked = { parse: (...args) => globalThis.__deliverablesComponentFixtures.parseMarkdown(...args) };",
    "docx-preview": "export const renderAsync = (...args) => globalThis.__deliverablesComponentFixtures.renderDocx(...args);",
  };
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.endsWith(".vue") && mocks[specifier]) {
        return { url: `fixture:${specifier}`, shortCircuit: true };
      }
      if (specifier.endsWith(".vue")) {
        return { url: new URL(specifier, context.parentURL || componentRoot).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith("fixture:")) {
        return { format: "module", source: mocks[url.slice("fixture:".length)], shortCircuit: true };
      }
      if (!url.endsWith(".vue")) return nextLoad(url, context);
      const filename = fileURLToPath(url);
      const source = readFileSync(filename, "utf8");
      const { descriptor } = parse(source, { filename });
      const script = compileScript(descriptor, { id: filename });
      const result = ts.transpileModule(script.content, {
        fileName: filename,
        compilerOptions: {
          module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
          inlineSourceMap: true, inlineSources: true,
        },
      });
      return { format: "module", source: result.outputText, shortCircuit: true };
    },
  });
  return () => {
    hooks.deregister();
    sourceLoader.deregister();
    Reflect.deleteProperty(globalThis, "__deliverablesComponentFixtures");
  };
}

type HostNode = { parent: HostNode | null; children: HostNode[]; text: string };
const node = (text = ""): HostNode => ({ parent: null, children: [], text });
const renderer = createRenderer<HostNode, HostNode>({
  createElement: () => node(),
  createText: node,
  createComment: node,
  insert(child, parent) { child.parent = parent; parent.children.push(child); },
  remove(child) {
    if (child.parent) child.parent.children = child.parent.children.filter((item) => item !== child);
  },
  setText(child, text) { child.text = text; },
  setElementText(child, text) { child.text = text; },
  parentNode: (child) => child.parent,
  nextSibling: () => null,
  patchProp: () => undefined,
});

export function mountComponent(component: any, initialProps: Record<string, unknown>) {
  const props = reactive({ ...initialProps });
  let instance: any;
  const target = { ...component, render: () => null };
  const app = renderer.createApp(defineComponent({
    setup: () => () => h(target, {
      ...props, ref: (value: any) => { if (value) instance = value; },
    }),
  }));
  app.mount(node());
  const state = instance.$.setupState;
  let mounted = true;
  return { props, state, unmount: () => {
    if (mounted) app.unmount();
    mounted = false;
  } };
}
