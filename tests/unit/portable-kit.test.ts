import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assemblePortableKit, copyPortableNodeRuntime } from '../../src/local/portable-kit.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-dispatcher-portable-'));
  roots.push(root);
  return root;
}

function assembleWindowsKit(
  source: string,
  destination: string,
  includeAssets = true,
  nodeExecutable = process.execPath,
) {
  return assemblePortableKit(
    source,
    destination,
    includeAssets,
    nodeExecutable,
    'windows-x64',
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('portable USB kit assembly', () => {
  it('copies the built app and supplied offline assets without downloading anything', () => {
    const source = tempRoot();
    const destination = join(source, 'portable-kit');
    mkdirSync(join(source, 'dist'), { recursive: true });
    mkdirSync(join(source, 'runtime', 'cpu'), { recursive: true });
    mkdirSync(join(source, 'models', 'cpu-lite'), { recursive: true });
    writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("portable");');
    writeFileSync(join(source, 'fake-node.exe'), 'node');
    writeFileSync(join(source, 'runtime', 'cpu', 'runtime-manifest.json'), '{}');
    writeFileSync(join(source, 'models', 'cpu-lite', 'model-pack.json'), '{}');

    const result = assembleWindowsKit(source, destination, true, join(source, 'fake-node.exe'));

    expect(result.copiedAssets).toEqual({ runtime: true, models: true });
    expect(result.bundledDependencies).toBe(true);
    expect(result.copiedNodeRuntime).toBe(true);
    expect(existsSync(join(destination, 'app', 'dist', 'cli.js'))).toBe(true);
    expect(existsSync(join(destination, 'runtime', 'node', 'node.exe'))).toBe(true);
    expect(existsSync(join(destination, 'runtime', 'cpu', 'runtime-manifest.json'))).toBe(true);
    expect(existsSync(join(destination, 'models', 'cpu-lite', 'model-pack.json'))).toBe(true);
    expect(readFileSync(join(destination, 'bin', 'ai-dispatcher.cmd'), 'utf8')).toContain('AI_DISPATCHER_PORTABLE_ROOT');
    const portableConfig = readFileSync(join(destination, 'config', '.ai-dispatcher.yml'), 'utf8');
    expect(portableConfig).toContain('offlineKitRequired: true');
    expect(portableConfig).toContain('requireIndependentReview: true');
    expect(readFileSync(join(destination, 'bin', 'start-cpu16.cmd'), 'utf8')).toContain('local start');
    expect(readFileSync(join(destination, 'bin', 'start-cpu32.cmd'), 'utf8')).toContain('local start');
    expect(readFileSync(join(destination, 'bin', 'start-cpu16.cmd'), 'utf8')).not.toContain('qwen2.5-coder');
    expect(readFileSync(join(destination, 'README.txt'), 'utf8')).toContain('genuinely separate provider');
    expect(readFileSync(join(destination, '사용방법.txt'), 'utf8')).toContain('BLOCKED_BY_POLICY');
  });

  it('bundles the prep guide as plain .txt, not markdown, for offline air-gapped reading', () => {
    const source = tempRoot();
    const destination = join(source, 'portable-kit');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("portable");');
    writeFileSync(join(source, 'fake-node.exe'), 'node');

    assembleWindowsKit(source, destination, false, join(source, 'fake-node.exe'));

    expect(existsSync(join(destination, 'kit-준비-가이드.txt'))).toBe(true);
    expect(existsSync(join(destination, 'kit-준비-가이드.md'))).toBe(false);
    const guide = readFileSync(join(destination, 'kit-준비-가이드.txt'), 'utf8');
    // No markdown syntax: a plain-text reader on an air-gapped machine would show
    // literal #/**/[]()/| characters instead of rendering them.
    expect(guide).not.toMatch(/^#{1,6} /m);
    expect(guide).not.toContain('**');
    expect(guide).not.toMatch(/\[.+\]\(https?:\/\//);
    expect(guide).toContain('BLOCKED_BY_POLICY');
    expect(readFileSync(join(destination, '사용방법.txt'), 'utf8')).toContain('kit-준비-가이드.txt');
  });

  it('flags a missing bundled git and wires the launcher to prefer it when present', () => {
    const source = tempRoot();
    const destination = join(source, 'portable-kit');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("portable");');
    writeFileSync(join(source, 'fake-node.exe'), 'node');

    const withoutGit = assembleWindowsKit(source, destination, false, join(source, 'fake-node.exe'));
    expect(withoutGit.requiredBeforeUse).toContain('a portable git (MinGit, "cmd" flavor) under runtime/git - every dispatch needs it, even air-gapped');
    expect(existsSync(join(destination, 'runtime', 'git', 'PUT_GIT_HERE.txt'))).toBe(true);
    const launcher = readFileSync(join(destination, 'bin', 'ai-dispatcher.cmd'), 'utf8');
    expect(launcher).toContain('runtime\\git\\cmd\\git.exe');
    expect(launcher).toContain('runtime\\git\\cmd;%PATH%');

    const destinationWithGit = join(source, 'portable-kit-with-git');
    mkdirSync(join(source, 'runtime', 'git', 'cmd'), { recursive: true });
    writeFileSync(join(source, 'runtime', 'git', 'cmd', 'git.exe'), 'fake-git');
    const withGit = assembleWindowsKit(source, destinationWithGit, true, join(source, 'fake-node.exe'));
    expect(withGit.requiredBeforeUse).not.toContain('a portable git (MinGit, "cmd" flavor) under runtime/git - every dispatch needs it, even air-gapped');
    expect(existsSync(join(destinationWithGit, 'runtime', 'git', 'cmd', 'git.exe'))).toBe(true);
  });

  it('installs a global git shim backed by the bundled git, alongside the ai-dispatcher shim', () => {
    const source = tempRoot();
    const destination = join(source, 'portable-kit');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("portable");');
    writeFileSync(join(source, 'fake-node.exe'), 'node');

    assembleWindowsKit(source, destination, false, join(source, 'fake-node.exe'));

    const gitGlobal = readFileSync(join(destination, 'bin', 'git-global.cmd'), 'utf8');
    expect(gitGlobal).toContain('portable-ai-dispatcher\\portable-kit.json');
    expect(gitGlobal).toContain('runtime\\git\\cmd\\git.exe');

    const installer = readFileSync(join(destination, 'bin', 'install-command.cmd'), 'utf8');
    expect(installer).toContain('git-global.cmd');
    expect(installer).toContain('TARGET_BIN%\\git.cmd');

    const uninstaller = readFileSync(join(destination, 'bin', 'uninstall-command.cmd'), 'utf8');
    expect(uninstaller).toContain('git.cmd');
  });

  it('flags a missing Next.js template as optional and copies one when present', () => {
    const source = tempRoot();
    const destination = join(source, 'portable-kit');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("portable");');
    writeFileSync(join(source, 'fake-node.exe'), 'node');

    const withoutTemplate = assembleWindowsKit(source, destination, false, join(source, 'fake-node.exe'));
    expect(withoutTemplate.requiredBeforeUse).toContain('(optional) a pre-built templates/nextjs-starter/ with node_modules installed, for bin\\new-nextjs-project.cmd');
    expect(existsSync(join(destination, 'templates', 'PUT_PROJECT_TEMPLATES_HERE.txt'))).toBe(true);
    const script = readFileSync(join(destination, 'bin', 'new-nextjs-project.cmd'), 'utf8');
    expect(script).toContain('templates\\nextjs-starter');
    expect(script).toContain('robocopy');

    const destinationWithTemplate = join(source, 'portable-kit-with-template');
    mkdirSync(join(source, 'templates', 'nextjs-starter', 'node_modules'), { recursive: true });
    writeFileSync(join(source, 'templates', 'nextjs-starter', 'package.json'), '{}');
    const withTemplate = assembleWindowsKit(source, destinationWithTemplate, true, join(source, 'fake-node.exe'));
    expect(withTemplate.requiredBeforeUse).not.toContain('(optional) a pre-built templates/nextjs-starter/ with node_modules installed, for bin\\new-nextjs-project.cmd');
    expect(existsSync(join(destinationWithTemplate, 'templates', 'nextjs-starter', 'package.json'))).toBe(true);
  });

  it('flags missing React/Vue templates as optional and copies them when present', () => {
    const source = tempRoot();
    const destination = join(source, 'portable-kit');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("portable");');
    writeFileSync(join(source, 'fake-node.exe'), 'node');

    const withoutTemplates = assembleWindowsKit(source, destination, false, join(source, 'fake-node.exe'));
    expect(withoutTemplates.requiredBeforeUse).toContain('(optional) a pre-built templates/react-starter/ with node_modules installed, for bin\\new-react-project.cmd');
    expect(withoutTemplates.requiredBeforeUse).toContain('(optional) a pre-built templates/vue-starter/ with node_modules installed, for bin\\new-vue-project.cmd');

    const reactScript = readFileSync(join(destination, 'bin', 'new-react-project.cmd'), 'utf8');
    expect(reactScript).toContain('templates\\react-starter');
    expect(reactScript).toContain('new-react-project.cmd DESTINATION_FOLDER');
    expect(reactScript).toContain('robocopy');

    const vueScript = readFileSync(join(destination, 'bin', 'new-vue-project.cmd'), 'utf8');
    expect(vueScript).toContain('templates\\vue-starter');
    expect(vueScript).toContain('new-vue-project.cmd DESTINATION_FOLDER');
    expect(vueScript).toContain('robocopy');

    const destinationWithTemplates = join(source, 'portable-kit-with-templates');
    mkdirSync(join(source, 'templates', 'react-starter', 'node_modules'), { recursive: true });
    writeFileSync(join(source, 'templates', 'react-starter', 'package.json'), '{}');
    mkdirSync(join(source, 'templates', 'vue-starter', 'node_modules'), { recursive: true });
    writeFileSync(join(source, 'templates', 'vue-starter', 'package.json'), '{}');
    const withTemplates = assembleWindowsKit(source, destinationWithTemplates, true, join(source, 'fake-node.exe'));
    expect(withTemplates.requiredBeforeUse).not.toContain('(optional) a pre-built templates/react-starter/ with node_modules installed, for bin\\new-react-project.cmd');
    expect(withTemplates.requiredBeforeUse).not.toContain('(optional) a pre-built templates/vue-starter/ with node_modules installed, for bin\\new-vue-project.cmd');
    expect(existsSync(join(destinationWithTemplates, 'templates', 'react-starter', 'package.json'))).toBe(true);
    expect(existsSync(join(destinationWithTemplates, 'templates', 'vue-starter', 'package.json'))).toBe(true);
  });

  it('refuses to overwrite an existing destination', () => {
    const source = tempRoot();
    const destination = join(source, 'already-there');
    mkdirSync(join(source, 'dist'), { recursive: true });
    mkdirSync(destination);
    writeFileSync(join(source, 'dist', 'cli.js'), 'x');
    expect(() => assembleWindowsKit(source, destination)).toThrow(/already exists/i);
  });

  it('assembles a self-contained Apple Silicon kit with POSIX launchers and scoped assets', () => {
    const source = tempRoot();
    const destination = join(source, 'portable-mac');
    const runtime = join(source, 'runtime', 'macos-arm64');
    mkdirSync(join(source, 'dist'), { recursive: true });
    mkdirSync(join(runtime, 'node', 'bin'), { recursive: true });
    mkdirSync(join(runtime, 'git', 'bin'), { recursive: true });
    mkdirSync(join(runtime, 'llamacpp', 'bin'), { recursive: true });
    mkdirSync(join(source, 'models', 'cpu-standard'), { recursive: true });
    writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("portable");');
    writeFileSync(join(source, 'dist', 'windows_process_tree-test.node'), 'wrong-platform-native-addon');
    writeFileSync(join(runtime, 'node', 'bin', 'node'), 'mac-node');
    writeFileSync(join(runtime, 'git', 'bin', 'git'), 'mac-git');
    writeFileSync(join(runtime, 'llamacpp', 'bin', 'llama-server'), 'mac-llama');
    writeFileSync(join(runtime, 'llamacpp', 'runtime-manifest.json'), JSON.stringify({
      schemaVersion: '1', runtimeId: 'llamacpp-metal-macos-arm64', acceleration: 'metal',
      os: 'darwin', arch: 'arm64', executable: 'bin/llama-server',
    }));
    writeFileSync(join(source, 'models', 'cpu-standard', 'model-pack.json'), '{}');

    const result = assemblePortableKit(source, destination, true, process.execPath, 'macos-arm64');

    expect(result).toMatchObject({ target: 'macos-arm64', copiedNodeRuntime: true, integrityLocked: true, copiedAssets: { runtime: true, models: true } });
    expect(existsSync(join(destination, 'kit-lock.json'))).toBe(true);
    expect(existsSync(join(destination, 'bin', 'ai-dispatcher'))).toBe(true);
    expect(existsSync(join(destination, 'bin', 'ai-dispatcher.cmd'))).toBe(false);
    expect(existsSync(join(destination, 'app', 'dist', 'windows_process_tree-test.node'))).toBe(false);
    expect(readFileSync(join(destination, 'bin', 'ai-dispatcher'), 'utf8')).toContain('runtime/node/bin/node');
    expect(readFileSync(join(destination, 'bin', 'start-local'), 'utf8')).toContain('local start');
    expect(readFileSync(join(destination, 'bin', 'start-local'), 'utf8')).not.toContain('25769803776');
    expect(readFileSync(join(destination, 'bin', 'install-command'), 'utf8')).toContain('Refusing to overwrite existing command');
    expect(readFileSync(join(destination, 'bin', 'uninstall-command'), 'utf8')).toContain('owned by another installation');
    expect(readFileSync(join(destination, 'bin', 'preflight'), 'utf8')).toContain('uname -m');
    expect(readFileSync(join(destination, 'README.txt'), 'utf8')).toContain('Use APFS');
    expect(readFileSync(join(destination, '사용방법.txt'), 'utf8')).toContain('BLOCKED_BY_POLICY');
    expect(JSON.parse(readFileSync(join(destination, 'portable-kit.json'), 'utf8'))).toMatchObject({ target: 'macos-arm64', os: 'darwin', arch: 'arm64' });
    expect(result.requiredBeforeUse).not.toContain('a complete macOS arm64 Node.js 22+ distribution under runtime/node');
    expect(result.requiredBeforeUse).not.toContain('a reviewed macOS arm64 Metal llama.cpp runtime and runtime-manifest.json under runtime/llamacpp');
    expect(result.requiredBeforeUse).not.toContain('at least one verified GGUF model pack under models/');
    expect(result.requiredBeforeUse).not.toContain('a relocatable macOS arm64 Git distribution under runtime/git - every dispatch needs it, even air-gapped');
  });

  it('copies only a macOS-scoped prepared template into a macOS kit', () => {
    const source = tempRoot();
    const destination = join(source, 'portable-mac');
    mkdirSync(join(source, 'dist'), { recursive: true });
    mkdirSync(join(source, 'templates', 'nextjs-starter', 'node_modules'), { recursive: true });
    mkdirSync(join(source, 'templates', 'macos-arm64', 'nextjs-starter', 'node_modules'), { recursive: true });
    writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("portable");');
    writeFileSync(join(source, 'templates', 'nextjs-starter', 'windows-only.txt'), 'must not copy');
    writeFileSync(join(source, 'templates', 'macos-arm64', 'nextjs-starter', 'mac-only.txt'), 'copy me');

    const result = assemblePortableKit(source, destination, true, process.execPath, 'macos-arm64');

    expect(existsSync(join(destination, 'templates', 'nextjs-starter', 'windows-only.txt'))).toBe(false);
    expect(existsSync(join(destination, 'templates', 'nextjs-starter', 'mac-only.txt'))).toBe(true);
    expect(result.requiredBeforeUse).not.toContain('(optional) a macOS arm64 pre-built templates/nextjs-starter/ with node_modules installed');
  });

  it('never copies the current Windows Node executable into a macOS target', () => {
    const source = tempRoot();
    const destination = join(source, 'portable-mac');
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'dist', 'cli.js'), 'console.log("portable");');

    const result = assemblePortableKit(source, destination, false, process.execPath, 'macos-arm64');

    expect(result.copiedNodeRuntime).toBe(false);
    expect(existsSync(join(destination, 'runtime', 'node', 'bin', 'node'))).toBe(false);
    expect(result.requiredBeforeUse).toContain('a complete macOS arm64 Node.js 22+ distribution under runtime/node');
    expect(() => copyPortableNodeRuntime(destination, process.execPath)).toThrow(/complete Node\.js distribution/i);
  });
});
