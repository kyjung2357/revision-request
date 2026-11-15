import type {Decision} from './core';
import type {RevisionRequest} from './request';

export interface PdfReviewEntry {
  id: string;
  index: number;
  originalDecision: Decision;
  reason?: string;
}
export interface PdfReviewManifest {
  format: 'revision-request-pdf';
  formatVersion: 1;
  exportId: string;
  createdAt: string;
  path: string;
  proposalIdentity: string;
  sourceHash: string;
  request: RevisionRequest;
  entries: PdfReviewEntry[];
}
export interface PdfReviewAnchor {
  entryId: string;
  page: number; // zero-based
  x: number;
  y: number; // PDF coordinates, from bottom of page
}
export interface PdfReviewSourceEntry {
  id: string;
  index: number;
  start: number;
  end: number;
  before: string;
  after: string;
  reason?: string;
}
export interface PdfGenerationProgress {
  stage: 'confirming' | 'preparing' | 'diffing' | 'compiling' | 'annotating' | 'saving';
  startedAt: number;
  message: string;
}
export type PdfCompilationProgressReporter = (progress: Pick<PdfGenerationProgress, 'stage' | 'message'>) => void;
export interface PdfGenerationResult {
  outcome: 'created' | 'cancelled' | 'failed';
  error?: string;
}

export interface LatexReviewPdfInput {
  workspaceRoot: string;
  targetPath: string; // absolute target path
  source: string; // exact current target text
  entries: PdfReviewSourceEntry[]; // pending entries only, in display order
  outputDirectory: string;
}
export interface CompiledReviewPdf {
  pdf: Uint8Array;
  anchors: PdfReviewAnchor[];
  warnings: string[];
}
export interface ImportedPdfReview {
  manifest: PdfReviewManifest;
  decisions: Record<string, Decision>;
  pdfHash: string;
}
export interface PdfReviewState {
  supported: boolean;
  available: boolean;
  imported?: boolean;
  filename: string;
  error?: string;
  pending?: number;
  accepted?: number;
  ignored?: number;
  canApply?: boolean;
  applied?: boolean;
  pdfHash?: string;
  warnings?: string[];
}
