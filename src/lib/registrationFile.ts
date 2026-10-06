/** The registration form's answers as the operator picked them: the Excel file itself or its CSV export. */
export type RegistrationFile = { kind: 'csv'; csvText: string } | { kind: 'xlsx'; dataBase64: string };

export const REGISTRATION_FILE_TYPES =
  '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Excel on a Belgian Windows laptop saves CSV as Windows-1252, so anything that isn't valid UTF-8 is read as that. */
export function decodeCsvBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Excel files are read on the laptop's server, so they travel as base64. */
export async function readRegistrationFile(file: File): Promise<RegistrationFile> {
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    return { kind: 'csv', csvText: decodeCsvBytes(new Uint8Array(await file.arrayBuffer())) };
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Bestand lezen mislukt'));
    reader.readAsDataURL(file);
  });
  return { kind: 'xlsx', dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}
