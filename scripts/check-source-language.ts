import { projectFiles } from "./source-files";

const javascript = (await projectFiles()).filter((path) => /\.(?:[cm]?js|jsx)$/i.test(path));
if (javascript.length > 0) {
  throw new Error(`Project sources must use TypeScript/TSX; migrate these files:\n${javascript.join("\n")}`);
}
process.stdout.write("TypeScript source policy verified: no JS/JSX/MJS/CJS project files\n");
