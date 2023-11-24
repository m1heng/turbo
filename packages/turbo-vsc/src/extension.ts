import {
  ExtensionContext,
  window,
  languages,
  commands,
  workspace,
  StatusBarAlignment,
  StatusBarItem,
  TextEditor,
  Range,
  Uri,
  env,
} from "vscode";
import * as net from "net";
import * as cp from "child_process";
import * as path from "path";

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { subscribe } from "diagnostics_channel";

import { visit } from "jsonc-parser";

let client: LanguageClient;

let toolbar: StatusBarItem;

// thunks passed to this function will executed
// after no calls have been made for `waitMs` milliseconds
const useDebounce = <T>(func: (args: T) => void, waitMs: number) => {
  let timeout: any;
  return (args: T) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      func(args);
    }, waitMs);
  };
};

const decoration = window.createTextEditorDecorationType({
  color: "#04f1f9", // something like cyan
});

function rainbowRgb(i: number) {
  const f = 0.5;
  const r = Math.sin(f * i + (4.0 * Math.PI) / 3.0) * 127.0 + 128.0;
  const g = 45;
  const b = Math.sin(f * i) * 127.0 + 128.0;

  return `#${Math.round(r).toString(16).padStart(2, "0")}${Math.round(g)
    .toString(16)
    .padStart(2, "0")}${Math.round(b).toString(16).padStart(2, "0")}`;
}

const pipelineColors = [...Array(10).keys()].map(rainbowRgb).map((color) =>
  window.createTextEditorDecorationType({
    color,
  })
);

const refreshDecorations = useDebounce(updateJSONDecorations, 1000);

export function activate(context: ExtensionContext) {
  const options: cp.ExecOptions = {
    cwd: workspace.workspaceFolders?.[0].uri.path,
  };

  context.subscriptions.push(
    commands.registerCommand("turbo.daemon.start", () => {
      cp.exec("source ~/.nvm/nvm.sh; turbo daemon start", options, (err) => {
        if (err) {
          if (err.message.includes("command not found")) {
            promptGlobalTurbo();
          } else {
            window.showErrorMessage(err.message);
          }
        } else {
          updateStatusBarItem(true);
          window.showInformationMessage("Turbo daemon started");
        }
      });
    })
  );

  context.subscriptions.push(
    commands.registerCommand("turbo.daemon.stop", () => {
      cp.exec("source ~/.nvm/nvm.sh; turbo daemon stop", options, (err) => {
        if (err) {
          if (err.message.includes("command not found")) {
            promptGlobalTurbo();
          } else {
            window.showErrorMessage(err.message);
          }
        } else {
          updateStatusBarItem(false);
          window.showInformationMessage("Turbo daemon stopped");
        }
      });
    })
  );

  context.subscriptions.push(
    commands.registerCommand("turbo.daemon.status", () => {
      cp.exec("source ~/.nvm/nvm.sh; turbo daemon status", options, (err) => {
        if (err) {
          if (err.message.includes("command not found")) {
            promptGlobalTurbo();
          } else {
            window.showErrorMessage(err.message);
            updateStatusBarItem(false);
          }
        } else {
          updateStatusBarItem(true);
          window.showInformationMessage("Turbo daemon is running");
        }
      });
    })
  );

  context.subscriptions.push(
    commands.registerCommand("turbo.run", (args) => {
      let terminal = window.createTerminal({
        name: `${args}`,
        isTransient: true,
        iconPath: Uri.joinPath(context.extensionUri, "resources", "icon.svg"),
      });
      terminal.sendText(`turbo run ${args}`);
      terminal.show();
    })
  );

  context.subscriptions.push(
    commands.registerCommand("turbo.codemod", (args) => {
      let terminal = window.createTerminal({
        name: "Turbo Codemod",
        isTransient: true,
        iconPath: Uri.joinPath(context.extensionUri, "resources", "icon.svg"),
      });
      terminal.sendText(`npx --yes @turbo/codemod ${args}`);
      terminal.show();
    })
  );

  context.subscriptions.push(
    commands.registerCommand("turbo.install", (args) => {
      let terminal = window.createTerminal({
        name: "Install Turbo",
        isTransient: true,
        iconPath: Uri.joinPath(context.extensionUri, "resources", "icon.svg"),
      });
      terminal.sendText(`npm i -g turbo && exit`);
      terminal.show();

      return new Promise((resolve) => {
        let dispose = window.onDidCloseTerminal((terminal) => {
          if (terminal.name === "Install Turbo") {
            dispose.dispose();
            resolve(terminal.exitStatus?.code);
          }
        });
      });
    })
  );

  toolbar = window.createStatusBarItem(StatusBarAlignment.Left, 100);
  commands.executeCommand("turbo.daemon.start");

  // decorate when changing the active editor editor
  context.subscriptions.push(
    window.onDidChangeActiveTextEditor(
      (editor) => updateJSONDecorations(editor),
      null,
      context.subscriptions
    )
  );

  // decorate when the document changes
  context.subscriptions.push(
    workspace.onDidChangeTextDocument(
      (event) => {
        if (
          window.activeTextEditor &&
          event.document === window.activeTextEditor.document
        ) {
          refreshDecorations(window.activeTextEditor);
        }
      },
      null,
      context.subscriptions
    )
  );

  // decorate the active editor now
  updateJSONDecorations(window.activeTextEditor);

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used

  let lspPath = Uri.joinPath(
    context.extensionUri,
    "out",
    `turborepo-lsp-${process.platform}-${process.arch}`
  ).fsPath;

  const serverOptions: ServerOptions = {
    run: {
      command: lspPath,
    },
    debug: {
      command: lspPath,
    },
  };

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    // Register the server for turbo json documents
    documentSelector: [
      { scheme: "file", pattern: "**/turbo.json" },
      { scheme: "file", pattern: "**/package.json" },
    ],
  };

  // Create the language client and start the client.
  client = new LanguageClient(
    "turboLSP",
    "Turborepo Language Server",
    serverOptions,
    clientOptions
  );

  // Start the client. This will also launch the server
  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}

function updateStatusBarItem(running: boolean) {
  toolbar.command = running ? "turbo.daemon.stop" : "turbo.daemon.start";
  toolbar.text = running ? `Turbo Running` : "Turbo Stopped";
  toolbar.show();
}

function updateJSONDecorations(editor?: TextEditor) {
  if (
    !editor ||
    !path.basename(editor.document.fileName).endsWith("turbo.json")
  ) {
    return;
  }

  let isPipelineKey = false;
  let pipelineDepth = -1; // indicates we're not in a pipeline block

  const ranges: Range[] = [];
  visit(editor.document.getText(), {
    onObjectProperty: (property, offset, length) => {
      if (property === "pipeline") {
        isPipelineKey = true;
        for (let i = 1; i < 9; i++) {
          let index = i + offset;
          editor.setDecorations(pipelineColors[i], [
            new Range(
              editor.document.positionAt(index),
              editor.document.positionAt(index + 1)
            ),
          ]);
        }
      }
      if (isPipelineKey && pipelineDepth === 0) {
        ranges.push(
          new Range(
            editor.document.positionAt(offset),
            editor.document.positionAt(offset + length)
          )
        );
      }
    },
    onObjectBegin: (offset, length) => {
      if (isPipelineKey && pipelineDepth === -1) {
        pipelineDepth = 0;
      } else if (pipelineDepth !== -1) {
        pipelineDepth += 1;
      }
    },
    onObjectEnd: (offset, length) => {
      if (pipelineDepth === 0) {
        pipelineDepth = -1;
      } else if (pipelineDepth !== -1) {
        pipelineDepth -= 1;
      }
    },
  });

  // editor.setDecorations(decoration, ranges);
}

async function promptGlobalTurbo() {
  let answer = await window.showErrorMessage(
    "Turbo CLI not found. Please install Turbo CLI to use this extension.",
    "Install Now"
  );

  if (answer === "Install Now") {
    let exitCode = await commands.executeCommand("turbo.install");
    if (exitCode === 0) {
      window.showInformationMessage("Turbo CLI installed");
      await commands.executeCommand("turbo.daemon.start");
    } else {
      let message = await window.showErrorMessage(
        "Unable to install Turbo CLI. Please install manually.",
        "Open Docs"
      );

      if (message === "Open Docs") {
        env.openExternal(Uri.parse("https://turbo.build/repo/docs/installing"));
      }
    }
  }
}