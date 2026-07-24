const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const CONTROL_KEYWORDS = new Set([
  'at',
  'as',
  'behind',
  'onlayer',
  'zorder',
  'with',
  'in',
  'xalign',
  'yalign',
  'xcenter',
  'ycenter',
  'xpos',
  'ypos',
  'zoom',
  'xzoom',
  'yzoom',
  'alpha',
  'rotate',
  'crop',
  'size',
  'anchor',
  'pos',
  'align'
]);

const DOCUMENT_SELECTORS = [
  { scheme: 'file', pattern: '**/*.rpy' },
  { scheme: 'file', pattern: '**/*.rpym' }
];

const MISSING_SCAN_CACHE_MS = 5 * 60 * 1000;

function activate(context) {
  const state = createState();
  const diagnostics = vscode.languages.createDiagnosticCollection('renpyImagePreview');
  const missingListStatusButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  missingListStatusButton.command = 'renpyImagePreview.listMissingImages';
  missingListStatusButton.text = '$(list-selection) Ren\'Py Missing Images';
  missingListStatusButton.tooltip = 'Scan workspace and list missing static show/scene images';
  const insertImageStatusButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  insertImageStatusButton.command = 'renpyImagePreview.insertImageFromProject';
  insertImageStatusButton.text = '$(image) Insert Ren\'Py Image';
  insertImageStatusButton.tooltip = 'Open a searchable image picker for the current Ren\'Py line';

  const updateMissingListStatusButton = () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && isSupportedDocument(editor.document)) {
      missingListStatusButton.show();
    } else {
      missingListStatusButton.hide();
    }
  };

  const updateInsertImageStatusButton = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupportedDocument(editor.document)) {
      insertImageStatusButton.hide();
      return;
    }

    insertImageStatusButton.show();
  };

  const hoverProvider = vscode.languages.registerHoverProvider(DOCUMENT_SELECTORS, {
    async provideHover(document, position) {
      const line = document.lineAt(position.line);
      const reference = extractVisualReference(line.text);
      if (!reference) {
        return null;
      }

      if (reference.isDynamic) {
        return buildDynamicHover(reference, line.range);
      }

      const resolution = await resolveReference(document, reference, state);
      return buildHover(reference, resolution, line.range);
    }
  });

  const codeActionProvider = vscode.languages.registerCodeActionsProvider(
    DOCUMENT_SELECTORS,
    {
      provideCodeActions(document, range) {
        const target = getImageInsertTarget(document, range.start.line);
        if (!target) {
          return null;
        }

        const action = new vscode.CodeAction('Insert image from project', vscode.CodeActionKind.QuickFix);
        action.command = {
          command: 'renpyImagePreview.insertImageFromProject',
          title: 'Insert image from project',
          arguments: [{ uri: document.uri.toString(), lineNumber: range.start.line }]
        };
        return [action];
      }
    },
    {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    }
  );

  const showPreviewCommand = vscode.commands.registerCommand('renpyImagePreview.showPreview', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const line = editor.document.lineAt(editor.selection.active.line);
    const reference = extractVisualReference(line.text);
    if (!reference) {
      vscode.window.showInformationMessage('No Ren\'Py show/scene statement found on the current line.');
      return;
    }

    if (reference.isDynamic) {
      vscode.window.showInformationMessage('This Ren\'Py show/scene line uses expression-based loading, so the preview extension cannot resolve it to a fixed image file.');
      return;
    }

    const resolution = await resolveReference(editor.document, reference, state);
    showPreviewPanel(context, reference, resolution);
  });

  const insertImageFromProjectCommand = vscode.commands.registerCommand('renpyImagePreview.insertImageFromProject', async (args) => {
    const target = await resolveImageInsertTarget(args, { allowFallbackShowInsert: true });
    if (!target) {
      vscode.window.showInformationMessage('Open a supported Ren\'Py file to insert an image from the project.');
      return;
    }

    await showImageInsertPicker(target, state);
  });

  const copyImageNameCommand = vscode.commands.registerCommand('renpyImagePreview.copyImageName', async (imageName) => {
    if (typeof imageName !== 'string' || imageName.trim().length === 0) {
      vscode.window.showInformationMessage('No Ren\'Py image name was provided to copy.');
      return;
    }

    await vscode.env.clipboard.writeText(imageName);
    vscode.window.setStatusBarMessage(`Copied image name: ${imageName}`, 2000);
  });

  const listMissingImagesCommand = vscode.commands.registerCommand('renpyImagePreview.listMissingImages', async () => {
    await showMissingImageOverview(state, false);
  });

  const rescanMissingImagesCommand = vscode.commands.registerCommand('renpyImagePreview.rescanMissingImages', async () => {
    await showMissingImageOverview(state, true);
  });

  const refreshIndexCommand = vscode.commands.registerCommand('renpyImagePreview.refreshIndex', async () => {
    state.cache.clear();
    clearMissingScanCache(state);
    void refreshAllDiagnostics(state, diagnostics);
    vscode.window.showInformationMessage('Ren\'Py image preview index cleared. It will rebuild on the next hover or preview command.');
  });

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{png,jpg,jpeg,webp,gif,bmp}');
  const invalidateCache = () => {
    state.cache.clear();
    clearMissingScanCache(state);
    void refreshAllDiagnostics(state, diagnostics);
  };
  watcher.onDidCreate(invalidateCache);
  watcher.onDidChange(invalidateCache);
  watcher.onDidDelete(invalidateCache);

  context.subscriptions.push(
    diagnostics,
    missingListStatusButton,
    insertImageStatusButton,
    vscode.workspace.onDidOpenTextDocument((document) => {
      void refreshDocumentDiagnostics(document, state, diagnostics);
      updateInsertImageStatusButton();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      markDocumentDirty(state, event.document.uri);
      void refreshDocumentDiagnostics(event.document, state, diagnostics);
      updateInsertImageStatusButton();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      clearDocumentDirty(state, document.uri);
      clearMissingScanCache(state);
      void refreshDocumentDiagnostics(document, state, diagnostics);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      clearDocumentDirty(state, document.uri);
      diagnostics.delete(document.uri);
      updateInsertImageStatusButton();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('renpyImagePreview')) {
        state.cache.clear();
        clearMissingScanCache(state);
        void refreshAllDiagnostics(state, diagnostics);
      }
      updateMissingListStatusButton();
      updateInsertImageStatusButton();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateMissingListStatusButton();
      updateInsertImageStatusButton();
    }),
    vscode.window.onDidChangeTextEditorSelection(() => {
      updateInsertImageStatusButton();
    })
  );

  void refreshAllDiagnostics(state, diagnostics);
  updateMissingListStatusButton();
  updateInsertImageStatusButton();

  context.subscriptions.push(
    codeActionProvider,
    hoverProvider,
    showPreviewCommand,
    insertImageFromProjectCommand,
    listMissingImagesCommand,
    rescanMissingImagesCommand,
    copyImageNameCommand,
    refreshIndexCommand,
    watcher
  );
}

function deactivate() {}

function createState() {
  return {
    cache: new Map(),
    missingScanCache: null,
    dirtyDocuments: new Set()
  };
}

function isIgnoredScriptUri(uri) {
  if (!uri || uri.scheme !== 'file') {
    return false;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return false;
  }

  const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/').toLowerCase();
  return relativePath === 'renpy' || relativePath.startsWith('renpy/');
}

function clearMissingScanCache(state) {
  state.missingScanCache = null;
}

function markDocumentDirty(state, documentUri) {
  if (documentUri) {
    state.dirtyDocuments.add(documentUri.toString());
  }
}

function clearDocumentDirty(state, documentUri) {
  if (documentUri) {
    state.dirtyDocuments.delete(documentUri.toString());
  }
}

function hasDirtySupportedDocuments(state) {
  for (const document of vscode.workspace.textDocuments) {
    if (isSupportedDocument(document) && document.isDirty) {
      markDocumentDirty(state, document.uri);
    }
  }

  return state.dirtyDocuments.size > 0;
}

function hasValidMissingScanCache(state) {
  return (
    state.missingScanCache
    && Array.isArray(state.missingScanCache.entries)
    && typeof state.missingScanCache.expiresAt === 'number'
    && Date.now() < state.missingScanCache.expiresAt
  );
}

function isSupportedDocument(document) {
  return (
    document.uri.scheme === 'file'
    && !isIgnoredScriptUri(document.uri)
    && (document.fileName.endsWith('.rpy') || document.fileName.endsWith('.rpym'))
  );
}

function stripComment(lineText) {
  const commentIndex = lineText.indexOf('#');
  if (commentIndex === -1) {
    return lineText;
  }
  return lineText.slice(0, commentIndex);
}

function getImageInsertTarget(document, lineNumber) {
  if (!document || !isSupportedDocument(document) || lineNumber < 0 || lineNumber >= document.lineCount) {
    return null;
  }

  const lineText = document.lineAt(lineNumber).text;
  if (/^\s*#/.test(lineText)) {
    return null;
  }

  const source = stripComment(lineText);
  if (!source.trim()) {
    return null;
  }

  const match = /^(\s*)(show|scene)\b(.*)$/.exec(source);
  if (!match) {
    return null;
  }

  const indentation = match[1];
  const kind = match[2];
  const rest = match[3] || '';
  const afterKeywordCharacter = indentation.length + kind.length;
  const trimmedRest = rest.trim();

  if (/^expression\b/.test(trimmedRest)) {
    return null;
  }

  if (kind === 'show' && /^screen\b/.test(trimmedRest)) {
    return null;
  }

  const firstContentOffset = rest.search(/\S/);
  const contentStartCharacter = firstContentOffset === -1 ? source.length : afterKeywordCharacter + firstContentOffset;
  const remainder = firstContentOffset === -1 ? '' : rest.slice(firstContentOffset);
  const aliasSlice = remainder ? getAliasSlice(remainder) : '';
  const aliasTrimmed = aliasSlice.trim();

  if (aliasTrimmed.length > 0) {
    return {
      documentUri: document.uri,
      lineNumber,
      kind,
      range: new vscode.Range(
        lineNumber,
        contentStartCharacter,
        lineNumber,
        contentStartCharacter + aliasSlice.trimEnd().length
      ),
      replacementPrefix: '',
      replacementSuffix: ''
    };
  }

  if (firstContentOffset !== -1) {
    return {
      documentUri: document.uri,
      lineNumber,
      kind,
      range: new vscode.Range(
        lineNumber,
        afterKeywordCharacter,
        lineNumber,
        contentStartCharacter
      ),
      replacementPrefix: ' ',
      replacementSuffix: ' '
    };
  }

  return {
    documentUri: document.uri,
    lineNumber,
    kind,
    range: new vscode.Range(lineNumber, afterKeywordCharacter, lineNumber, source.length),
    replacementPrefix: ' ',
    replacementSuffix: ''
  };
}

function getFallbackShowInsertTarget(document, lineNumber) {
  if (!document || !isSupportedDocument(document) || lineNumber < 0 || lineNumber >= document.lineCount) {
    return null;
  }

  const line = document.lineAt(lineNumber);
  const indentation = (/^\s*/.exec(line.text) || [''])[0];

  return {
    documentUri: document.uri,
    lineNumber,
    kind: 'show',
    range: new vscode.Range(lineNumber, line.range.end.character, lineNumber, line.range.end.character),
    replacementPrefix: `\n${indentation}show `,
    replacementSuffix: ''
  };
}

function extractVisualReference(lineText) {
  // Fast path: fully commented lines never contain active Ren'Py statements.
  if (/^\s*#/.test(lineText)) {
    return null;
  }

  const source = stripComment(lineText);
  if (!source.trim()) {
    return null;
  }

  const match = /^(\s*)(show|scene)(\s+)(.+)$/.exec(source);
  if (!match) {
    return null;
  }

  const indentation = match[1];
  const kind = match[2].toLowerCase();
  const separator = match[3];
  const remainder = match[4];
  const contentStart = indentation.length + kind.length + separator.length;
  const trimmedRemainder = remainder.trim();
  if (!trimmedRemainder) {
    return null;
  }

  if (/^expression\b/.test(trimmedRemainder)) {
    const dynamicText = trimmedRemainder.split(/\s+/).slice(0, 2).join(' ');
    return {
      kind,
      alias: dynamicText,
      displayText: trimmedRemainder,
      isDynamic: true,
      range: new vscode.Range(0, contentStart, 0, contentStart + trimmedRemainder.length)
    };
  }

  // `show screen ...` references Ren'Py UI screens, not image assets.
  if (kind === 'show' && /^screen\b/.test(trimmedRemainder)) {
    return null;
  }

  const tokens = remainder.split(/\s+/);
  const aliasTokens = [];
  for (const token of tokens) {
    if (CONTROL_KEYWORDS.has(token.toLowerCase())) {
      break;
    }
    aliasTokens.push(token);
  }

  if (aliasTokens.length === 0) {
    return null;
  }

  const aliasSlice = getAliasSlice(remainder);

  return {
    kind,
    alias: aliasTokens.join(' '),
    displayText: aliasSlice.trim(),
    isDynamic: false,
    range: new vscode.Range(0, contentStart, 0, contentStart + aliasSlice.trimEnd().length)
  };
}

function getAliasSlice(remainder) {
  const tokenPattern = /\S+/g;
  let tokenMatch = tokenPattern.exec(remainder);
  let endIndex = remainder.length;

  while (tokenMatch) {
    if (CONTROL_KEYWORDS.has(tokenMatch[0].toLowerCase())) {
      endIndex = tokenMatch.index;
      break;
    }
    tokenMatch = tokenPattern.exec(remainder);
  }

  return remainder.slice(0, endIndex);
}

async function resolveReference(document, reference, state) {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    return {
      alias: reference.alias,
      matches: [],
      suggestions: []
    };
  }

  const index = await getOrBuildIndex(workspaceFolder, state);
  const normalizedAlias = normalizeKey(reference.alias);
  const matches = index.byBaseName.get(normalizedAlias) || [];

  if (matches.length > 0) {
    return {
      alias: reference.alias,
      matches,
      suggestions: []
    };
  }

  const suggestions = [];
  for (const [key, files] of index.byBaseName.entries()) {
    if (key.startsWith(normalizedAlias) || normalizedAlias.startsWith(key) || key.includes(normalizedAlias)) {
      for (const file of files) {
        suggestions.push(file);
        if (suggestions.length >= 5) {
          break;
        }
      }
    }
    if (suggestions.length >= 5) {
      break;
    }
  }

  return {
    alias: reference.alias,
    matches: [],
    suggestions
  };
}

async function getOrBuildIndex(workspaceFolder, state) {
  const key = workspaceFolder.uri.toString();
  const cached = state.cache.get(key);
  if (cached) {
    return cached;
  }

  const index = {
    byBaseName: new Map(),
    allEntries: []
  };

  const config = vscode.workspace.getConfiguration('renpyImagePreview', workspaceFolder.uri);
  const searchRoots = config.get('searchRoots', ['game/images', 'images']);

  for (const root of searchRoots) {
    const rootPath = path.join(workspaceFolder.uri.fsPath, root);
    if (!fs.existsSync(rootPath)) {
      continue;
    }
    await indexImages(rootPath, workspaceFolder.uri.fsPath, index);
  }

  index.allEntries.sort((left, right) => {
    const leftKey = `${left.baseName}\u0000${left.relativePath}`.toLowerCase();
    const rightKey = `${right.baseName}\u0000${right.relativePath}`.toLowerCase();
    return leftKey.localeCompare(rightKey);
  });

  state.cache.set(key, index);
  return index;
}

async function indexImages(directoryPath, workspaceRoot, index) {
  const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      await indexImages(fullPath, workspaceRoot, index);
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) {
      continue;
    }

    const baseName = path.basename(entry.name, extension);
    const normalized = normalizeKey(baseName);
    const relativePath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
    const fileEntry = {
      uri: vscode.Uri.file(fullPath),
      relativePath,
      baseName
    };

    index.allEntries.push(fileEntry);

    if (!index.byBaseName.has(normalized)) {
      index.byBaseName.set(normalized, []);
    }
    index.byBaseName.get(normalized).push(fileEntry);
  }
}

function normalizeKey(value) {
  return value
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getIgnoredStaticNames(documentUri) {
  const config = vscode.workspace.getConfiguration('renpyImagePreview', documentUri);
  const configured = config.get('ignoredStaticImageNames', ['black', 'blank', 'white']);
  const ignored = new Set();

  for (const value of configured) {
    if (typeof value !== 'string') {
      continue;
    }

    const normalized = normalizeKey(value);
    if (normalized.length > 0) {
      ignored.add(normalized);
    }
  }

  return ignored;
}

function shouldIgnoreStaticReference(reference, documentUri) {
  return getIgnoredStaticNames(documentUri).has(normalizeKey(reference.alias));
}

async function refreshAllDiagnostics(state, diagnostics) {
  const documents = vscode.workspace.textDocuments.filter(isSupportedDocument);
  await Promise.all(documents.map((document) => refreshDocumentDiagnostics(document, state, diagnostics)));
}

async function showMissingImageOverview(state, forceRescan) {
  const scanResult = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: forceRescan
        ? 'Ren\'Py Image Preview: Rescanning all .rpy/.rpym files'
        : 'Ren\'Py Image Preview: Building missing-image overview',
      cancellable: false
    },
    async (progress) => getMissingImageReferences(state, forceRescan, progress)
  );

  if (scanResult.fromCache) {
    vscode.window.setStatusBarMessage('Ren\'Py Image Preview: Using cached missing-image overview (valid for 5 minutes).', 3000);
  }

  if (scanResult.entries.length === 0) {
    vscode.window.showInformationMessage('No missing static show/scene images were found in the workspace.');
    return;
  }

  const quickPickItems = scanResult.entries.map((entry) => ({
    label: `${entry.kind} ${entry.alias}`,
    description: `${entry.relativePath}:${entry.lineNumber + 1}`,
    detail: entry.lineText.trim(),
    entry
  }));

  const selection = await vscode.window.showQuickPick(quickPickItems, {
    title: `Missing static images (${quickPickItems.length})`,
    placeHolder: 'Select an entry to jump to its file and line',
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (!selection) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(selection.entry.uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const lineNumber = selection.entry.lineNumber;
  const targetRange = new vscode.Range(
    lineNumber,
    selection.entry.range.start.character,
    lineNumber,
    selection.entry.range.end.character
  );
  editor.selection = new vscode.Selection(targetRange.start, targetRange.end);
  editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenter);
}

function getVisibleEditorForDocument(documentUri) {
  if (!documentUri) {
    return null;
  }

  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === documentUri.toString()) {
      return editor;
    }
  }

  return null;
}

async function resolveImageInsertTarget(args, options = {}) {
  if (args && typeof args.uri === 'string' && typeof args.lineNumber === 'number') {
    const uri = vscode.Uri.parse(args.uri);
    const document = await vscode.workspace.openTextDocument(uri);
    const target = getImageInsertTarget(document, args.lineNumber);
    if (target) {
      return target;
    }

    if (options.allowFallbackShowInsert) {
      return getFallbackShowInsertTarget(document, args.lineNumber);
    }

    return null;
  }

  if (options.preferredDocumentUri) {
    const preferredEditor = getVisibleEditorForDocument(options.preferredDocumentUri);
    if (preferredEditor) {
      const preferredTarget = getImageInsertTarget(preferredEditor.document, preferredEditor.selection.active.line);
      if (preferredTarget) {
        return preferredTarget;
      }

      if (options.allowFallbackShowInsert) {
        return getFallbackShowInsertTarget(preferredEditor.document, preferredEditor.selection.active.line);
      }
    }
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return null;
  }

  const target = getImageInsertTarget(editor.document, editor.selection.active.line);
  if (target) {
    return target;
  }

  if (options.allowFallbackShowInsert) {
    return getFallbackShowInsertTarget(editor.document, editor.selection.active.line);
  }

  return null;
}

async function showImageInsertPicker(target, state) {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(target.documentUri);
  if (!workspaceFolder) {
    vscode.window.showInformationMessage('Open the file inside a workspace to use the image picker.');
    return;
  }

  const index = await getOrBuildIndex(workspaceFolder, state);
  if (!index.allEntries.length) {
    vscode.window.showInformationMessage('No images were found in the configured search roots.');
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'renpyImageInsertPicker',
    `Insert Ren'Py Image: ${target.kind}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [workspaceFolder.uri]
    }
  );

  panel.webview.html = renderImageInsertPickerHtml(panel.webview, index.allEntries);
  let lastKnownTarget = target;

  panel.webview.onDidReceiveMessage(async (message) => {
    if (!message || message.command !== 'insertImage' || typeof message.imageName !== 'string') {
      return;
    }

    const activeTarget = await resolveImageInsertTarget(null, {
      allowFallbackShowInsert: true,
      preferredDocumentUri: target.documentUri
    });
    const targetToUse = activeTarget || lastKnownTarget;

    if (!targetToUse) {
      vscode.window.showInformationMessage('Open a supported Ren\'Py file to insert an image.');
      return;
    }

    await applyImageInsertSelection(targetToUse, message.imageName);
    lastKnownTarget = targetToUse;

    const keepOpen = vscode.workspace.getConfiguration('renpyImagePreview').get('keepImagePickerOpen', true);
    if (!keepOpen) {
      panel.dispose();
    }
  });
}

async function applyImageInsertSelection(target, imageName) {
  const replacementText = `${target.replacementPrefix || ''}${imageName}${target.replacementSuffix || ''}`;
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.replace(target.documentUri, target.range, replacementText);
  await vscode.workspace.applyEdit(workspaceEdit);
}

async function getMissingImageReferences(state, forceRescan, progress) {
  const hasDirtyDocuments = hasDirtySupportedDocuments(state);

  if (!forceRescan && !hasDirtyDocuments && hasValidMissingScanCache(state)) {
    return {
      fromCache: true,
      entries: state.missingScanCache.entries
    };
  }

  const entries = await collectMissingImageReferences(state, progress);
  if (!hasDirtyDocuments) {
    state.missingScanCache = {
      entries,
      expiresAt: Date.now() + MISSING_SCAN_CACHE_MS
    };
  }

  return {
    fromCache: false,
    entries
  };
}

async function collectMissingImageReferences(state, progress) {
  const files = await vscode.workspace.findFiles('**/*.{rpy,rpym}', '**/renpy/**');
  const missingEntries = [];
  const totalFiles = files.length;

  if (progress) {
    progress.report({
      increment: 0,
      message: `Scanning all .rpy and .rpym files (0/${totalFiles})`
    });
  }

  for (let index = 0; index < files.length; index += 1) {
    const uri = files[index];
    const document = await vscode.workspace.openTextDocument(uri);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const relativePath = workspaceFolder
      ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/')
      : uri.fsPath;

    if (progress) {
      const scanned = index + 1;
      progress.report({
        increment: totalFiles > 0 ? 100 / totalFiles : 100,
        message: `Scanning all .rpy and .rpym files (${scanned}/${totalFiles})`
      });
    }

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
      const line = document.lineAt(lineNumber);
      const reference = extractVisualReference(line.text);
      if (!reference || reference.isDynamic) {
        continue;
      }

      if (shouldIgnoreStaticReference(reference, uri)) {
        continue;
      }

      const resolution = await resolveReference(document, reference, state);
      if (resolution.matches.length > 0) {
        continue;
      }

      missingEntries.push({
        uri,
        lineNumber,
        kind: reference.kind,
        alias: reference.alias,
        lineText: line.text,
        range: reference.range,
        relativePath
      });
    }
  }

  return missingEntries;
}

async function refreshDocumentDiagnostics(document, state, diagnostics) {
  if (!isSupportedDocument(document)) {
    return;
  }

  const config = vscode.workspace.getConfiguration('renpyImagePreview', document.uri);
  if (!config.get('markMissingImages', true)) {
    diagnostics.delete(document.uri);
    return;
  }

  const documentDiagnostics = [];

  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
    const line = document.lineAt(lineNumber);
    const reference = extractVisualReference(line.text);
    if (!reference || reference.isDynamic) {
      continue;
    }

    if (shouldIgnoreStaticReference(reference, document.uri)) {
      continue;
    }

    const resolution = await resolveReference(document, reference, state);
    if (resolution.matches.length > 0) {
      continue;
    }

    const range = new vscode.Range(
      lineNumber,
      reference.range.start.character,
      lineNumber,
      reference.range.end.character
    );
    const diagnostic = new vscode.Diagnostic(
      range,
      `Ren'Py image not found: ${reference.alias}`,
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = 'Ren\'Py Image Preview';
    documentDiagnostics.push(diagnostic);
  }

  diagnostics.set(document.uri, documentDiagnostics);
}

function buildDynamicHover(reference, range) {
  const markdown = new vscode.MarkdownString('', false);
  markdown.appendMarkdown(`**Ren'Py ${reference.kind}**  \n`);
  markdown.appendCodeblock(reference.displayText, 'text');
  markdown.appendMarkdown('\nThis line uses `expression` and is loaded dynamically, so the extension cannot resolve a fixed image file to preview.');
  return new vscode.Hover(markdown, range);
}

function buildHover(reference, resolution, range) {
  const markdown = new vscode.MarkdownString('', true);
  markdown.isTrusted = true;
  markdown.supportHtml = true;
  markdown.appendMarkdown(`**Ren'Py ${reference.kind}**  \n`);
  markdown.appendCodeblock(reference.alias, 'text');

  const copyCommandUri = vscode.Uri.parse(
    `command:renpyImagePreview.copyImageName?${encodeURIComponent(JSON.stringify([reference.alias]))}`
  );
  markdown.appendMarkdown(`[Copy image name](${copyCommandUri.toString()})  \n`);

  if (resolution.matches.length > 0) {
    const firstMatch = resolution.matches[0];
    markdown.appendMarkdown(
      `\n<img src="${firstMatch.uri.toString()}" alt="Preview" width="180" style="max-width: 180px; max-height: 180px; object-fit: contain;" />\n`
    );

    const maxHoverMatches = vscode.workspace.getConfiguration('renpyImagePreview').get('maxHoverMatches', 3);
    const listedMatches = resolution.matches.slice(0, maxHoverMatches);
    markdown.appendMarkdown('\nMatched files:\n');
    for (const match of listedMatches) {
      markdown.appendMarkdown(`- ${match.relativePath}\n`);
    }
    if (resolution.matches.length > listedMatches.length) {
      markdown.appendMarkdown(`- +${resolution.matches.length - listedMatches.length} more\n`);
    }
  } else {
    markdown.appendMarkdown('\nImage not found in configured search roots.\n');
    if (resolution.suggestions.length > 0) {
      markdown.appendMarkdown('\nClosest matches:\n');
      for (const suggestion of resolution.suggestions) {
        markdown.appendMarkdown(`- ${suggestion.relativePath}\n`);
      }
    }
  }

  markdown.appendMarkdown('\nRun **Ren\'Py: Show Image Preview** for a larger panel.');

  return new vscode.Hover(markdown, range);
}

function showPreviewPanel(context, reference, resolution) {
  const panel = vscode.window.createWebviewPanel(
    'renpyImagePreview',
    `Ren'Py Preview: ${reference.alias}`,
    vscode.ViewColumn.Beside,
    {
      enableFindWidget: false,
      enableScripts: false,
      localResourceRoots: getLocalResourceRoots(resolution)
    }
  );

  panel.webview.html = renderPreviewHtml(panel.webview, reference, resolution);
}

function getLocalResourceRoots(resolution) {
  const roots = new Map();
  for (const item of resolution.matches.concat(resolution.suggestions)) {
    const directory = vscode.Uri.file(path.dirname(item.uri.fsPath));
    roots.set(directory.toString(), directory);
  }
  return Array.from(roots.values());
}

function renderPreviewHtml(webview, reference, resolution) {
  const firstMatch = resolution.matches[0];
  const imageMarkup = firstMatch
    ? `<img src="${webview.asWebviewUri(firstMatch.uri)}" alt="${escapeHtml(reference.alias)}" />`
    : '<div class="missing">No exact image match found.</div>';

  const matchList = resolution.matches.length > 0
    ? resolution.matches.map((match) => `<li>${escapeHtml(match.relativePath)}</li>`).join('')
    : '';

  const suggestionList = resolution.matches.length === 0 && resolution.suggestions.length > 0
    ? `<div class="section"><h2>Closest matches</h2><ul>${resolution.suggestions.map((item) => `<li>${escapeHtml(item.relativePath)}</li>`).join('')}</ul></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 16px;
    }
    h1, h2 {
      font-weight: 600;
      margin: 0 0 12px;
    }
    .alias {
      background: var(--vscode-textCodeBlock-background);
      border-radius: 6px;
      padding: 8px 10px;
      margin-bottom: 16px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .preview {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      padding: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 80%, black 20%);
    }
    img {
      display: block;
      max-width: 100%;
      max-height: 70vh;
      margin: 0 auto;
      object-fit: contain;
      border-radius: 8px;
    }
    .missing {
      padding: 24px;
      text-align: center;
      border: 1px dashed var(--vscode-descriptionForeground);
      border-radius: 8px;
      color: var(--vscode-descriptionForeground);
    }
    .section {
      margin-top: 16px;
    }
    ul {
      padding-left: 20px;
      margin: 8px 0 0;
    }
    li {
      margin: 6px 0;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <h1>Ren'Py ${escapeHtml(reference.kind)} preview</h1>
  <div class="alias">${escapeHtml(reference.alias)}</div>
  <div class="preview">${imageMarkup}</div>
  ${matchList ? `<div class="section"><h2>Matched files</h2><ul>${matchList}</ul></div>` : ''}
  ${suggestionList}
</body>
</html>`;
}

function renderImageInsertPickerHtml(webview, entries) {
  const serializedEntries = JSON.stringify(entries.map((entry) => ({
    imageName: entry.baseName,
    relativePath: entry.relativePath,
    previewUri: webview.asWebviewUri(entry.uri).toString()
  })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 16px;
    }
    .toolbar {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
      padding-bottom: 12px;
      z-index: 1;
    }
    input[type="search"] {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      padding: 10px 12px;
      border-radius: 8px;
      outline: none;
    }
    .meta {
      margin-top: 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .card {
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
      border-radius: 10px;
      overflow: hidden;
      cursor: pointer;
      padding: 0;
      text-align: left;
      color: inherit;
    }
    .card:hover {
      border-color: var(--vscode-focusBorder);
      transform: translateY(-1px);
    }
    .thumb {
      width: 100%;
      aspect-ratio: 1 / 1;
      object-fit: contain;
      display: block;
      background: color-mix(in srgb, var(--vscode-editor-background) 75%, black 25%);
    }
    .label {
      padding: 10px;
      font-size: 12px;
      font-weight: 600;
      word-break: break-word;
    }
    .path {
      padding: 0 10px 10px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      word-break: break-word;
    }
    .empty {
      display: none;
      margin-top: 24px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <input id="search" type="search" placeholder="Search image names or paths..." autofocus />
    <div id="count" class="meta"></div>
  </div>
  <div id="grid" class="grid"></div>
  <div id="empty" class="empty">No matching images.</div>
  <script>
    const vscode = acquireVsCodeApi();
    const entries = ${serializedEntries};
    const searchInput = document.getElementById('search');
    const grid = document.getElementById('grid');
    const count = document.getElementById('count');
    const empty = document.getElementById('empty');

    function escapeHtml(value) {
      return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function render() {
      const query = searchInput.value.trim().toLowerCase();
      const filtered = entries.filter((entry) => {
        if (!query) {
          return true;
        }
        return entry.imageName.toLowerCase().includes(query) || entry.relativePath.toLowerCase().includes(query);
      });

      count.textContent = filtered.length + ' image' + (filtered.length === 1 ? '' : 's');
      empty.style.display = filtered.length === 0 ? 'block' : 'none';
      grid.innerHTML = filtered.map((entry) => {
        return ''
          + '<button class="card" data-image-name="' + escapeHtml(entry.imageName) + '" title="' + escapeHtml(entry.imageName) + '">'
          + '<img class="thumb" src="' + entry.previewUri + '" alt="' + escapeHtml(entry.imageName) + '" />'
          + '<div class="label">' + escapeHtml(entry.imageName) + '</div>'
          + '<div class="path">' + escapeHtml(entry.relativePath) + '</div>'
          + '</button>';
      }).join('');

      for (const card of grid.querySelectorAll('.card')) {
        card.addEventListener('click', () => {
          vscode.postMessage({
            command: 'insertImage',
            imageName: card.dataset.imageName
          });
        });
      }
    }

    searchInput.addEventListener('input', render);
    render();
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  activate,
  deactivate
};