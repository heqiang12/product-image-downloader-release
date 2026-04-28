export interface ImportedLink {
  name?: string;
  url: string;
  platform?: string;
}

export interface ExcelImportResult {
  totalRows: number;
  validLinks: ImportedLink[];
  invalidRows: Array<{
    rowNumber: number;
    reason: string;
  }>;
}
