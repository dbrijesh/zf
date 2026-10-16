/// <reference types="vite/client" />
declare module 'monaco-editor/esm/vs/editor/editor.worker?worker' { const W: new () => Worker; export default W; }
declare module 'monaco-editor/esm/vs/language/json/json.worker?worker' { const W: new () => Worker; export default W; }
declare module 'monaco-yaml/yaml.worker?worker' { const W: new () => Worker; export default W; }
declare module 'monaco-editor/esm/vs/basic-languages/*/*.contribution';
declare module 'monaco-editor/esm/vs/language/json/monaco.contribution';
