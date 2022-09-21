import * as fs from 'fs';
import { commands, ExtensionContext, LinkedEditingRanges, window } from 'vscode';

const FSHARP_CELL = "NEW_CELL";
const PY_CELL = "# %%";

function readFile(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		fs.readFile(path, (err, data) => {
			if (err != null) {
				reject(err);
			}
			resolve(data.toString());
		})
	})
}

function stats(path: string): Promise<fs.Stats> {
	return new Promise((resolve, reject) =>
		fs.stat(path, (err, stats) => {
			if(err) {
				reject(err);
			}
			resolve(stats);
		})
	);
}

async function waitWhile(predicate: () => Promise<boolean>, intervalMs = 200, maxMs = 5000) {	
	let waitedMs = 0;
	while (await predicate()) {
		if (waitedMs > maxMs) {
			throw new Error("Timeout");
		}
		await sleep(intervalMs);
		waitedMs += intervalMs;
	}
}

function getLinesWhile(text: string, predicate: (line: string) => boolean): string[] {
	const lines: string[] = [];
	let prevLineBreak = 0;
	let nextLineBreak = text.indexOf('\n');
	while (nextLineBreak >= 0) {
		const line = text.substring(prevLineBreak, nextLineBreak).trim();
		if (line.length > 0) {
			if (!predicate(line)) {
				break;
			}
			lines.push(line);
		}
		prevLineBreak = nextLineBreak;
		nextLineBreak = text.indexOf('\n', nextLineBreak + 1);
	}
	return lines;
}

function sleep(ms: number) {
	return new Promise<void>(resolve => {
		setTimeout(function () {
			resolve()
		}, ms);
	});
}

function findOccurrences(text: string, pattern: string, start = 0, accumulated = 0) {
	const i = text.indexOf(pattern, start);
	return i === -1 ? accumulated : findOccurrences(text, pattern, i + pattern.length, accumulated + 1);
}

function findOccurrence(text: string, pattern: string, occurrence: number, start = 0) {
	const i = text.indexOf(pattern, start);
	if (i === -1) {
		return -1;
	}
	return occurrence <= 1 ? i : findOccurrence(text, pattern, occurrence - 1, i + pattern.length);
}

export function activate(context: ExtensionContext) {
	const pyImports = new Set<string>();

	context.subscriptions.push(commands.registerCommand('fablePython.resetimports', async () => {
		pyImports.clear();
		window.showInformationMessage("FABLE-PY: Imports have been reset");
	}));

	context.subscriptions.push(commands.registerTextEditorCommand('fablePython.runcurrentcell', async editor => {
		try {
			// First save file so Fable can compile the code
			await commands.executeCommand('workbench.action.files.save');

			const document = editor.document;
			const documentText = document.getText();
			const documentOffset = document.offsetAt(editor.selection.start);

			const cells = findOccurrences(documentText.substring(0, documentOffset), FSHARP_CELL);
			if (cells < 1) {
				window.showInformationMessage(`FABLE-PY:Use ${FSHARP_CELL} to declare a new cell`)
				return;
			}

			const fsFile = editor.document.fileName;
			const pyFile = fsFile.replace(/\.fsx?$/, ".py");

			// Wait until Fable has updated the python file
			const fsStats = await stats(fsFile);
			try {
				await waitWhile(async () => {
					const pyStats = await stats(pyFile);
					return fsStats.mtime > pyStats.mtime;
				})
			} catch {
				throw new Error("Python file was not updated, is Fable running?")
			}

			const pyText = await readFile(pyFile);
			const newImports =
				getLinesWhile(pyText, line => /^(#|from\b|import\b)/.test(line))
				.filter(imp => !imp.startsWith("#") && !pyImports.has(imp));
			
			const pyCell = findOccurrence(pyText, PY_CELL, cells);
			let nextPyCell = findOccurrence(pyText, PY_CELL, 1, pyCell + PY_CELL.length);
			nextPyCell = nextPyCell < 0 ? pyText.length : nextPyCell;

			const textToRun = newImports.join('\n') + '\n' + pyText.substring(pyCell, nextPyCell);

			try {
				await commands.executeCommand('jupyter.execSelectionInteractive', textToRun);
			} catch {
				throw new Error("FABLE-PY: Cannot run selection, open Jupyter interactive window");
			}
			
			newImports.forEach(imp => pyImports.add(imp));
		}
		catch (error) {
			window.showErrorMessage("FABLE-PY: " + (error instanceof Error ? error.message : String(error)));
		}
	}));
}
