import * as vscode from 'vscode';

const PDF_VIEW = 'latex-workshop-pdf-hook';

export interface LatexPdfTab {
  uri: vscode.Uri;
  viewType: string;
  viewColumn: vscode.ViewColumn;
}
interface ObservedPdfTab extends LatexPdfTab {
  active: boolean;
}
export interface LatexPdfViewSnapshot {
  tabs: ObservedPdfTab[];
  sourceColumn: vscode.ViewColumn | undefined;
  viewer: string;
  destination: string;
}

function pdfTabs(): ObservedPdfTab[] {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs.flatMap(tab => {
    const input = tab.input;
    return input instanceof vscode.TabInputCustom && input.viewType === PDF_VIEW
      ? [{uri: input.uri, viewType: input.viewType, viewColumn: group.viewColumn, active: tab.isActive}]
      : [];
  }));
}
const sameTab = (a: LatexPdfTab, b: LatexPdfTab) =>
  a.uri.toString() === b.uri.toString() && a.viewType === b.viewType && a.viewColumn === b.viewColumn;

/** Observe the public tabs before Workshop resolves the source's actual root/output PDF. */
export function captureLatexPdfView(sourceColumn: vscode.ViewColumn | undefined): LatexPdfViewSnapshot {
  const config = vscode.workspace.getConfiguration('latex-workshop');
  return {
    tabs: pdfTabs(), sourceColumn,
    viewer: config.get<string>('view.pdf.viewer', 'tab'),
    destination: config.get<string>('view.pdf.tab.editorGroup', 'right')
  };
}

/** Select only the actual PDF surfaced by View; never guess a sibling source.pdf. */
export function resolveLatexPdfView(before: LatexPdfViewSnapshot): LatexPdfTab | undefined {
  // These viewers have no URI-bearing custom tab to activate through this API.
  if (['browser', 'external', 'legacy', 'singleton'].includes(before.viewer)) return undefined;
  const after = pdfTabs(), active = after.filter(tab => tab.active);
  const opened = active.filter(tab => !before.tabs.some(old => sameTab(old, tab)));
  if (opened.length === 1) return opened[0];
  if (opened.length > 1) throw new Error('Multiple PDF tabs opened. Choose the original PDF and try again.');
  const activated = active.filter(tab => before.tabs.some(old => sameTab(old, tab) && !old.active));
  if (activated.length === 1) return activated[0];
  if (activated.length > 1) throw new Error('Multiple PDF tabs became active. Choose the original PDF and try again.');
  const source = before.sourceColumn;
  const destination = source === undefined || source < 1 ? undefined :
    before.destination === 'current' ? source :
    before.destination === 'left' ? Math.max(1, source - 1) :
    before.destination === 'right' ? source + 1 : undefined;
  if (destination !== undefined) {
    const inDestination = active.filter(tab => tab.viewColumn === destination);
    if (inDestination.length === 1) return inDestination[0];
  }
  if (active.length === 1) return active[0];
  throw new Error('Could not identify the PDF opened by LaTeX Workshop. Open the original PDF and try again.');
}

/** Workshop preserves source focus; explicitly activate its identified PDF after forwarding. */
export async function focusLatexPdfView(target: LatexPdfTab): Promise<void> {
  const matches = pdfTabs().filter(tab => tab.uri.toString() === target.uri.toString() && tab.viewType === target.viewType);
  const current = matches.find(tab => tab.viewColumn === target.viewColumn) ?? (matches.length === 1 ? matches[0] : undefined);
  if (!current) throw new Error('The original PDF tab changed or closed. Try PDF navigation again.');
  await vscode.commands.executeCommand('vscode.openWith', current.uri, current.viewType, {
    viewColumn: current.viewColumn, preserveFocus: false, preview: false
  });
}

