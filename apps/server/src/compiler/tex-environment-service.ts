import { tmpdir } from "node:os";
import { isAbsolute, join, relative, delimiter } from "node:path";
import { realpath, readFile } from "node:fs/promises";
import {
  TEX_ENGINES,
  type CompileSettings,
  type TexEnvironmentStatus,
  type TexEngine,
} from "@fastwrite/shared";
import { ApiError } from "../http";
import { runCompilerProcess } from "./run-compiler-process";

interface Environment {
  id: string;
  label: string;
  binDirectory?: string;
  roots?: string[];
  image?: string;
}
/** Environment locations are operator configuration, never manuscript-controlled paths. */
export class TexEnvironmentService {
  private readonly environments: Environment[];
  private readonly catalogCache = new Map<
    string,
    { expiresAt: number; packages: string[]; classes: string[]; root: string }
  >();
  private readonly symbolCache = new Map<
    string,
    import("@fastwrite/shared").LatexSymbol[]
  >();
  constructor(configuration = process.env.FASTWRITE_TEX_ENVIRONMENTS) {
    this.environments = [{ id: "system", label: "服务器 TeX Live" }];
    if (configuration) {
      const configured: unknown = JSON.parse(configuration);
      if (!Array.isArray(configured))
        throw new Error("FASTWRITE_TEX_ENVIRONMENTS must be an array");
      for (const env of configured) {
        if (
          !env ||
          !/^[a-zA-Z0-9_-]{1,64}$/.test(env.id) ||
          this.environments.some((item) => item.id === env.id) ||
          typeof env.label !== "string"
        )
          throw new Error("Invalid FASTWRITE_TEX_ENVIRONMENTS entry");
        if (
          typeof env.image === "string" &&
          /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,240}$/.test(env.image)
        )
          this.environments.push({
            id: env.id,
            label: env.label,
            image: env.image,
          });
        else {
          if (
            typeof env.binDirectory !== "string" ||
            !isAbsolute(env.binDirectory) ||
            !Array.isArray(env.roots) ||
            !env.roots.length ||
            env.roots.some(
              (root: unknown) =>
                typeof root !== "string" ||
                !isAbsolute(root) ||
                root === "/" ||
                root.includes(".."),
            )
          )
            throw new Error("Invalid FASTWRITE_TEX_ENVIRONMENTS entry");
          this.environments.push({
            id: env.id,
            label: env.label,
            binDirectory: env.binDirectory,
            roots: env.roots,
          });
        }
      }
    }
  }
  get(id: string) {
    const env = this.environments.find((item) => item.id === id);
    if (!env)
      throw new ApiError(
        400,
        "tex_environment_unknown",
        "所选编译环境不存在，请重新选择",
      );
    return env;
  }
  executable(id: string, name: string) {
    const env = this.get(id);
    return Bun.which(env.binDirectory ? join(env.binDirectory, name) : name);
  }
  path(id: string) {
    const env = this.get(id);
    return [env.binDirectory, process.env.PATH ?? "/usr/bin:/bin"]
      .filter(Boolean)
      .join(delimiter);
  }
  async roots(id: string) {
    return Promise.all(
      (this.get(id).roots ?? []).map((root) => realpath(root)),
    );
  }
  async catalog(
    environmentId: string,
    documents: Array<{ path: string; content: string }>,
  ) {
    const { buildLatexIndex, withoutLatexComments } = await import(
      "@fastwrite/shared"
    );
    const empty = {
      packages: [] as string[],
      classes: [] as string[],
      packageSymbols: [] as import("@fastwrite/shared").LatexSymbol[],
    };
    if (this.get(environmentId).image) return empty;
    const kpse = this.executable(environmentId, "kpsewhich");
    if (!kpse) return empty;
    let catalog = this.catalogCache.get(environmentId);
    if (!catalog || catalog.expiresAt < Date.now()) {
      const result = await runCompilerProcess([kpse, "-var-value=TEXMFDIST"], {
        cwd: tmpdir(),
        timeoutMs: 3000,
        env: { PATH: this.path(environmentId), HOME: "/nonexistent" },
      });
      const root = result.log.trim();
      if (!isAbsolute(root) || root === "/") return empty;
      const packages: string[] = [],
        classes: string[] = [];
      const glob = new Bun.Glob("tex/**/*.{sty,cls}");
      for await (const path of glob.scan({
        cwd: root,
        onlyFiles: true,
        followSymlinks: false,
      })) {
        const name = path.split("/").at(-1)!;
        if (name.endsWith(".sty")) packages.push(name.slice(0, -4));
        else classes.push(name.slice(0, -4));
        if (packages.length + classes.length >= 20_000) break;
      }
      catalog = {
        expiresAt: Date.now() + 600_000,
        packages: [...new Set(packages)],
        classes: [...new Set(classes)],
        root,
      };
      this.catalogCache.set(environmentId, catalog);
    }
    const names = new Set<string>();
    for (const doc of documents.filter((doc) =>
      /\.(tex|sty|cls)$/i.test(doc.path),
    ))
      for (const match of withoutLatexComments(doc.content).matchAll(
        /\\(usepackage|RequirePackage|documentclass|LoadClass)(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g,
      ))
        for (const part of match[2]!.split(",")) {
          const name = part.trim();
          if (/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/.test(name))
            names.add(`${name}.${/class/i.test(match[1]!) ? "cls" : "sty"}`);
        }
    const packageSymbols: import("@fastwrite/shared").LatexSymbol[] = [];
    for (const file of [...names].slice(0, 30)) {
      const key = `${environmentId}:${file}`;
      let symbols = this.symbolCache.get(key);
      if (!symbols) {
        const located = await runCompilerProcess([kpse, file], {
          cwd: tmpdir(),
          timeoutMs: 3000,
          env: { PATH: this.path(environmentId), HOME: "/nonexistent" },
        });
        const path = located.log.trim();
        if (!isAbsolute(path)) continue;
        const actual = await realpath(path);
        const rel = relative(catalog.root, actual);
        if (rel.startsWith("..") || isAbsolute(rel)) continue;
        const data = Bun.file(actual);
        if (data.size > 1_000_000) continue;
        const content = await readFile(actual, "utf8");
        symbols = buildLatexIndex([
          { path: `@package/${file}`, version: 0, content },
        ]).symbols.filter(
          (symbol) => symbol.kind !== "label" && !symbol.name.includes("@"),
        );
        this.symbolCache.set(key, symbols);
        if (this.symbolCache.size > 300)
          this.symbolCache.delete(this.symbolCache.keys().next().value!);
      }
      packageSymbols.push(...symbols);
    }
    return {
      packages: catalog.packages,
      classes: catalog.classes,
      packageSymbols,
    };
  }
  async validate(settings: CompileSettings) {
    const env = this.get(settings.environmentId);
    if (env.image) {
      const docker = Bun.which("docker");
      if (!docker)
        throw new ApiError(
          503,
          "tex_container_unavailable",
          "服务器未安装 Docker，无法使用所选编译环境",
        );
      const result = await runCompilerProcess(
        [docker, "image", "inspect", "--format", "{{.Id}}", env.image],
        {
          cwd: tmpdir(),
          timeoutMs: 5000,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        },
      );
      if (result.exitCode !== 0)
        throw new ApiError(
          503,
          "tex_image_unavailable",
          "所选 TeX 镜像尚未由管理员安装",
        );
      return;
    }
    if (!this.executable(settings.environmentId, settings.engine))
      throw new ApiError(
        503,
        "tex_engine_unavailable",
        `环境中未安装 ${settings.engine}，请在项目设置中选择可用引擎`,
      );
    if (!this.executable(settings.environmentId, "latexmk"))
      throw new ApiError(
        503,
        "latexmk_unavailable",
        "编译环境需要 latexmk 来处理多轮编译与参考文献",
      );
  }
  async status(): Promise<TexEnvironmentStatus[]> {
    return Promise.all(
      this.environments.map(async (env) => {
        if (env.image) {
          let ready = false;
          try {
            await this.validate({ engine: "pdflatex", environmentId: env.id });
            ready = true;
          } catch {
            /* Report readiness without pulling arbitrary images. */
          }
          return {
            id: env.id,
            label: env.label,
            engines: TEX_ENGINES.map((engine) => ({
              engine,
              available: ready,
              version: ready ? env.image! : "镜像不可用",
            })),
            tools: ["latexmk", "bibtex", "biber", "kpsewhich"].map((name) => ({
              name,
              available: ready,
            })),
            sandboxAvailable: ready,
            ready,
          };
        }
        const tools = [
          "latexmk",
          "bibtex",
          "biber",
          "makeindex",
          "kpsewhich",
          "fc-list",
        ].map((name) => ({
          name,
          available: Boolean(this.executable(env.id, name)),
        }));
        const engines = await Promise.all(
          TEX_ENGINES.map(async (engine) => {
            const executable = this.executable(env.id, engine);
            let version: string | undefined;
            if (executable)
              try {
                const result = await runCompilerProcess(
                  [executable, "--version"],
                  {
                    cwd: tmpdir(),
                    timeoutMs: 3000,
                    env: { PATH: this.path(env.id) },
                  },
                );
                version = result.log.split("\n")[0]?.slice(0, 240);
              } catch {
                /* An unavailable probe must not hide the other environments. */
              }
            return {
              engine,
              available: Boolean(executable),
              ...(version ? { version } : {}),
            };
          }),
        );
        return {
          id: env.id,
          label: env.label,
          engines,
          tools,
          sandboxAvailable: Boolean(Bun.which("bwrap")),
          ready:
            engines.some((engine) => engine.available) && tools[0]!.available,
        };
      }),
    );
  }
}
export function engineFlag(engine: TexEngine) {
  return { pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex" }[
    engine
  ];
}

/** Inspects declared dependencies only; it never executes manuscript configuration. */
export async function inspectProjectEnvironment(
  service: TexEnvironmentService,
  settings: CompileSettings,
  documents: Array<{ path: string; content: string }>,
) {
  const { withoutLatexComments } = await import("@fastwrite/shared");
  const source = documents
    .filter((doc) => /\.tex$/i.test(doc.path))
    .map((doc) => withoutLatexComments(doc.content))
    .join("\n");
  const requested = new Set<string>();
  for (const match of source.matchAll(
    /\\(usepackage|RequirePackage|documentclass|LoadClass)(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g,
  ))
    for (const name of match[2]!.split(",").map((name) => name.trim()))
      if (/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/.test(name))
        requested.add(`${name}.${/class/i.test(match[1]!) ? "cls" : "sty"}`);
  const local = new Set(documents.map((doc) => doc.path));
  const executable = service.get(settings.environmentId).image
    ? null
    : service.executable(settings.environmentId, "kpsewhich");
  const dependencies: Array<{
    file: string;
    status: "project" | "installed" | "missing" | "unknown";
  }> = [];
  const names = [...requested].slice(0, 80);
  for (let i = 0; i < names.length; i += 4) {
    const batch = await Promise.all(
      names.slice(i, i + 4).map(async (file) => {
        if (local.has(file)) return { file, status: "project" as const };
        if (!executable) return { file, status: "unknown" as const };
        try {
          const result = await runCompilerProcess([executable, file], {
            cwd: tmpdir(),
            timeoutMs: 3000,
            env: {
              PATH: service.path(settings.environmentId),
              HOME: "/nonexistent",
            },
          });
          return {
            file,
            status:
              result.exitCode === 0 && result.log.trim()
                ? ("installed" as const)
                : ("missing" as const),
          };
        } catch {
          return { file, status: "unknown" as const };
        }
      }),
    );
    dependencies.push(...batch);
  }
  const warnings: string[] = [];
  if (service.get(settings.environmentId).image)
    warnings.push("容器环境的宏包依赖将在隔离编译时验证。");
  if (
    settings.engine === "pdflatex" &&
    /\\(?:setmainfont|setsansfont|setCJKmainfont|setmonofont)\b|\{(?:fontspec|xeCJK)\}/.test(
      source,
    )
  )
    warnings.push(
      "项目使用系统字体或 xeCJK，请选择 XeLaTeX；fontspec 也可使用 LuaLaTeX。",
    );
  if (requested.size > 80)
    warnings.push("依赖较多，仅检查前 80 项声明；最终以编译诊断为准。");
  return {
    settings,
    dependencies,
    warnings,
    missing: dependencies
      .filter((item) => item.status === "missing")
      .map((item) => item.file),
  };
}
