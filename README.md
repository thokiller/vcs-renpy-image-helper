# Ren'Py Image Preview

This VS Code extension previews project images referenced by Ren'Py `show` and `scene` statements.

## What it does

- Hover a `show` or `scene` line in a `.rpy` or `.rpym` file to see a popup preview.
- Use the light bulb on a `show` or `scene` line to open a searchable image selector.
- Use the status bar button `Insert Ren'Py Image` on any supported `.rpy` or `.rpym` file.
- Run `Ren'Py: Show Image Preview` to open a larger side panel for the current line.
- Run `Ren'Py: List Missing Static Images` to scan all `.rpy`/`.rpym` files and open a quick navigation list of unresolved static `show`/`scene` lines.
- If no exact image exists, the popup and panel show that clearly and list close filename matches when available.

## Insert image selector

The extension can open an image selector while editing supported `.rpy` and `.rpym` files.

You can trigger it by:

- Clicking the light bulb quick action
- Clicking the `Insert Ren'Py Image` status bar button
- Running `Ren'Py: Insert Image From Project` from the command palette

The selector includes:

- A search bar
- A 3-column thumbnail grid
- Click-to-insert behavior that writes the chosen image name into the current `show` or `scene` line

If your cursor is on a non-`show`/`scene` line, clicking a thumbnail inserts a new indented `show <image>` line below the current line.

By default, the selector panel stays open after insertion until you close it manually.

If the line already has transforms such as `at center` or `with dissolve`, the selector replaces only the image name and keeps the trailing modifiers.

## How matching works

The extension:

1. Parses the current line for a `show` or `scene` statement.
2. Removes common Ren'Py control keywords such as `at`, `with`, `behind`, and `zorder`.
3. Searches configured image roots for a file whose basename matches the remaining alias.

Example:

- `show nyxira maid expressionless mop talk at center with dissolve`
- Tries to match `nyxira maid expressionless mop talk`

## Settings

- `renpyImagePreview.searchRoots`: folders to scan for images.
- `renpyImagePreview.maxHoverMatches`: how many matched paths to list in the hover.
- `renpyImagePreview.markMissingImages`: whether unresolved static `show` and `scene` image names should be marked with a warning in the editor.
- `renpyImagePreview.ignoredStaticImageNames`: static image aliases to ignore for missing-image warnings and the missing-image quick list. Default: `black`, `blank`, `white`.
- `renpyImagePreview.keepImagePickerOpen`: keep the image selector panel open after insertion. Default: `true`.

## Missing image warnings

If `renpyImagePreview.markMissingImages` is enabled, the extension adds a warning squiggle to static `show` and `scene` image names that do not resolve to a real file.

If `renpyImagePreview.markMissingImages` is disabled, the extension still shows hover previews and missing-image information in the popup, but it will not add warning markers in the editor.

You can change this setting in VS Code:

1. Open Settings
2. Search for `Ren'Py Image Preview`
3. Find `Mark Missing Images`
4. Turn it on or off

## Quick navigation for missing images

Use `Ren'Py: List Missing Static Images` from the command palette when you want an overview.

You can also trigger this from the preview panel tab title button (list icon) while a Ren'Py preview panel is open.

For easier access, the same command is also available as:

- An editor title button when a `.rpy` or `.rpym` file is active
- A status bar button: `Ren'Py Missing Images`

This command:

- Runs on demand (manual trigger)
- Scans workspace Ren'Py files for static `show`/`scene` references with no matching image file
- Shows the results in a quick-pick list
- Lets you click an entry to jump directly to the file and line

To reduce repeated scan cost, the missing-image overview results are cached for 5 minutes.

- `Ren'Py: List Missing Static Images` uses the cache when valid.
- `Ren'Py: Rescan Missing Static Images` bypasses cache and rebuilds immediately.
- If you have unsaved changes in supported `.rpy` or `.rpym` files, the overview bypasses the saved-state cache for that run.
- The rescan action is also available as a title button in editor/webview contexts.

Default search roots:

- `game/images`
- `images`

## Local install

To test it locally in development:

1. Open the folder `tools/vscode-renpy-image-preview` in a separate VS Code window.
2. Press `F5` to launch an Extension Development Host.
3. Open your Ren'Py project in the Extension Development Host.
4. Hover a `show` or `scene` line, or run `Ren'Py: Show Image Preview` from the command palette.

## Build a VSIX

Use the included Windows helper script:

1. Double-click `build-vsix.cmd`
2. Or run it from Command Prompt in this folder

It will:

- Check that Node.js is installed
- Use `npx` to run `@vscode/vsce`
- Build a `.vsix` package in this folder

If you push a tag like `v0.0.5` to GitHub, the repository's release workflow will build the extension automatically and attach the generated `.vsix` to the matching GitHub Release.

## License

This extension is distributed under GPL-2.0-only so that redistributed modifications must stay open source under the same license.

## Install for yourself

After building, install the `.vsix` in one of these ways:

1. In VS Code, open Extensions
2. Click the `...` menu
3. Choose `Install from VSIX...`
4. Select the generated `.vsix` file

Or from a terminal:

```cmd
code --install-extension renpy-image-preview-0.0.1.vsix
```

## Install for friends

Send your friend the `.vsix` file.

They need to:

1. Have VS Code installed
2. Open Extensions in VS Code
3. Click the `...` menu
4. Choose `Install from VSIX...`
5. Select the `.vsix` file you sent them
6. Reload VS Code if prompted

They do not need Node.js just to install or use the extension.

## Updating later

Recommended workflow:

1. Keep this extension source in git
2. Make your code changes
3. Bump the `version` in `package.json`
4. Run `build-vsix.cmd`
5. Install the new `.vsix` yourself
6. Send the new `.vsix` to friends

Installing a newer `.vsix` replaces the older version.

## Limits

- `show expression ...` and `scene expression ...` are dynamic. The extension will explain that they cannot be previewed, and they are not marked as missing images.
- `show screen ...` is ignored because it targets Ren'Py screen UI definitions rather than image files.
- Fully commented lines (for example `# show ...` or `# scene ...`) are ignored by previews, warnings, and the missing-image overview.
- Files under the workspace `renpy/` engine folder are ignored by default for validation and missing-image overview scanning.
- Matching is filename-based. If the script alias differs from the actual asset filename, the extension will show no exact match and may offer close matches.