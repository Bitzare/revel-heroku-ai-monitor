// Tabla ordenable reutilizable (TanStack Table v8 + tabla de shadcn).

import {
  flexRender, getCoreRowModel, getSortedRowModel, useReactTable,
  type ColumnDef, type SortingState,
} from "@tanstack/react-table"
import { ArrowDown, ArrowUp } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    /** Columna numérica: alineada a la derecha y con cifras tabulares. */
    numeric?: boolean
    className?: string
  }
}

export function DataTable<T>({ columns, data, initialSort, empty, rowClassName, footer, getRowId, onRowClick }: {
  columns: ColumnDef<T, any>[] // eslint-disable-line @typescript-eslint/no-explicit-any
  data: T[]
  initialSort?: SortingState
  empty: ReactNode
  rowClassName?: (row: T) => string | undefined
  footer?: ReactNode
  getRowId?: (row: T) => string
  /** Fila navegable: clic o Enter. */
  onRowClick?: (row: T) => void
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSort ?? [])
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId,
  })

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((hg) => (
          <TableRow key={hg.id} className="hover:bg-transparent">
            {hg.headers.map((h) => {
              const meta = h.column.columnDef.meta
              const sorted = h.column.getIsSorted()
              return (
                <TableHead key={h.id} className={cn("text-xs font-medium text-muted-foreground", meta?.numeric && "text-right", meta?.className)}
                  aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}>
                  {h.column.getCanSort() ? (
                    <button type="button" onClick={h.column.getToggleSortingHandler()}
                      className={cn("inline-flex items-center gap-1 hover:text-foreground", meta?.numeric && "flex-row-reverse")}>
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {sorted === "asc" ? <ArrowUp className="size-3.5" /> : sorted === "desc" ? <ArrowDown className="size-3.5" /> : <span className="w-3.5" />}
                    </button>
                  ) : flexRender(h.column.columnDef.header, h.getContext())}
                </TableHead>
              )
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.length ? table.getRowModel().rows.map((row) => (
          <TableRow key={row.id} className={cn(onRowClick && "cursor-pointer", rowClassName?.(row.original))}
            {...(onRowClick ? {
              tabIndex: 0,
              onClick: () => onRowClick(row.original),
              onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter") onRowClick(row.original) },
            } : {})}>
            {row.getVisibleCells().map((cell) => {
              const meta = cell.column.columnDef.meta
              return (
                <TableCell key={cell.id} className={cn(meta?.numeric && "text-right tabular", meta?.className)}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              )
            })}
          </TableRow>
        )) : (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={columns.length} className="py-10 text-center whitespace-normal text-muted-foreground">{empty}</TableCell>
          </TableRow>
        )}
      </TableBody>
      {footer && <TableFooter>{footer}</TableFooter>}
    </Table>
  )
}
