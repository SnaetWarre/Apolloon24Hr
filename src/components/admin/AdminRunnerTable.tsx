import React from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { LabelBadge } from '../LabelBadge';
import { SourceBadge } from '../RunnerEntryModals';
import { statusLabel } from './adminFormat';
import type { Runner, RunnerRegistration } from '../../types';

export function AdminRunnerTable({
  runners,
  registrations,
  onOpenProfile,
  onRestore,
  onRemove,
}: {
  runners: Runner[];
  registrations: Record<string, RunnerRegistration>;
  onOpenProfile: (runnerId: string) => void;
  onRestore: (runner: Runner) => Promise<void>;
  onRemove: (runner: Runner) => Promise<void>;
}) {
  const columns = React.useMemo<ColumnDef<Runner>[]>(
    () => [
      { header: 'Nr.', accessorFn: (runner) => runner.runnerNumber || '-' },
      { header: 'Naam', accessorKey: 'name' },
      {
        header: 'Status',
        cell: ({ row }) => (
          <>
            {statusLabel(row.original.status)}
            {row.original.hiddenFromQueue ? ' · verborgen' : ''}
          </>
        ),
      },
      {
        header: 'Beschikbare uren',
        cell: ({ row }) => {
          const hours = registrations[row.original.id]?.availableHours ?? [];
          return hours.length ? hours.join(', ') : 'Niet opgegeven';
        },
      },
      {
        header: 'Bron',
        cell: ({ row }) => <SourceBadge source={row.original.registrationSource} />,
      },
      {
        header: 'Labels',
        cell: ({ row }) => (
          <div className="label-row">
            {row.original.labels.map((label) => (
              <LabelBadge key={label.id} label={label} compact />
            ))}
          </div>
        ),
      },
      { header: 'Toeren', accessorKey: 'lapCount' },
      {
        header: 'Acties',
        cell: ({ row }) => {
          const runner = row.original;
          return (
            <div className="runner-admin-actions">
              <button className="btn btn--sm" onClick={() => onOpenProfile(runner.id)}>
                Profiel
              </button>
              {runner.hiddenFromQueue && (
                <button className="btn btn--sm" onClick={() => void onRestore(runner)}>
                  Terug tonen
                </button>
              )}
              <button
                className="btn btn--sm btn--quiet btn--danger-outline"
                onClick={() => void onRemove(runner)}
                disabled={runner.lapCount > 0 || runner.status === 'running'}
              >
                Verwijder
              </button>
            </div>
          );
        },
      },
    ],
    [onOpenProfile, onRemove, onRestore, registrations]
  );

  const table = useReactTable({
    data: runners,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <table>
      <thead>
        {table.getHeaderGroups().map((headerGroup) => (
          <tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <th key={header.id}>
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.original.id}>
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
            ))}
          </tr>
        ))}
        {table.getRowModel().rows.length === 0 && (
          <tr>
            <td colSpan={columns.length}>Geen lopers gevonden.</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
