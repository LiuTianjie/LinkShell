import {
  useMemo,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { DesktopIcon } from "../icons";
import { cn } from "./utils";

export type SortDirection = "asc" | "desc";

export interface DataTableColumn<Row> {
  id: string;
  header: ReactNode;
  cell: (row: Row, index: number) => ReactNode;
  align?: "left" | "center" | "right";
  numeric?: boolean;
  width?: string | number;
  sortable?: boolean;
  sortAccessor?: (row: Row) => string | number;
  headerClassName?: string;
  cellClassName?: string;
}

export interface DataTableProps<Row>
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  getRowKey: (row: Row, index: number) => string;
  /** Accessible name for the scrollable table region (`responsive-table`). */
  label: string;
  caption?: ReactNode;
  emptyState?: ReactNode;
  sortColumnId?: string;
  sortDirection?: SortDirection;
  defaultSortColumnId?: string;
  defaultSortDirection?: SortDirection;
  onSortChange?: (columnId: string, direction: SortDirection) => void;
  onRowClick?: (row: Row) => void;
  compact?: boolean;
}

export function DataTable<Row>({
  columns,
  rows,
  getRowKey,
  label,
  caption,
  emptyState,
  sortColumnId: controlledSortCol,
  sortDirection: controlledSortDir,
  defaultSortColumnId,
  defaultSortDirection = "desc",
  onSortChange,
  onRowClick,
  compact = false,
  className,
  ...props
}: DataTableProps<Row>) {
  const [uncontrolledCol, setUncontrolledCol] = useState<string | undefined>(
    defaultSortColumnId,
  );
  const [uncontrolledDir, setUncontrolledDir] =
    useState<SortDirection>(defaultSortDirection);

  const activeSortCol =
    controlledSortCol !== undefined ? controlledSortCol : uncontrolledCol;
  const activeSortDir =
    controlledSortDir !== undefined ? controlledSortDir : uncontrolledDir;

  const sortedRows = useMemo(() => {
    if (!activeSortCol) return rows;
    const col = columns.find((c) => c.id === activeSortCol);
    if (!col || !col.sortable || !col.sortAccessor) return rows;
    const accessor = col.sortAccessor;
    const factor = activeSortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = accessor(a);
      const vb = accessor(b);
      if (typeof va === "number" && typeof vb === "number") {
        return (va - vb) * factor;
      }
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * factor;
    });
  }, [rows, columns, activeSortCol, activeSortDir]);

  const handleSortClick = (col: DataTableColumn<Row>) => {
    if (!col.sortable) return;
    const nextDir: SortDirection =
      activeSortCol === col.id
        ? activeSortDir === "asc"
          ? "desc"
          : "asc"
        : "desc";
    if (controlledSortCol === undefined) {
      setUncontrolledCol(col.id);
    }
    if (controlledSortDir === undefined) {
      setUncontrolledDir(nextDir);
    }
    onSortChange?.(col.id, nextDir);
  };

  return (
    /* MWG `responsive-table`: `tabIndex={0}` on scroll container ensures keyboard-only scrolling. */
    <div
      tabIndex={0}
      role="region"
      aria-label={label}
      data-compact={compact ? "true" : undefined}
      className={cn("ls-table-container", className)}
      {...props}
    >
      <table className="ls-table">
        {caption ? <caption className="ls-sr-only">{caption}</caption> : null}
        <thead className="ls-table__head">
          <tr>
            {columns.map((col) => {
              const isSorted = col.sortable && activeSortCol === col.id;
              const ariaSortValue: "ascending" | "descending" | undefined =
                isSorted
                  ? activeSortDir === "asc"
                    ? "ascending"
                    : "descending"
                  : undefined;
              const align = col.align ?? (col.numeric ? "right" : "left");

              return (
                /* MWG `sortable-table`: `aria-sort` set ONLY on the active sorted `<th>`, omitted on all others. */
                <th
                  key={col.id}
                  scope="col"
                  aria-sort={ariaSortValue}
                  data-align={align}
                  style={
                    col.width !== undefined
                      ? { width: col.width }
                      : undefined
                  }
                  className={cn("ls-table__th", col.headerClassName)}
                >
                  {col.sortable ? (
                    /* MWG `sortable-table`: `<button type="button">` inside `<th>`, never clickable `<th>` itself. */
                    <button
                      type="button"
                      className="ls-table__sort-btn"
                      onClick={() => handleSortClick(col)}
                    >
                      <span>{col.header}</span>
                      <span
                        className="ls-table__sort-icon"
                        data-active={isSorted ? "true" : undefined}
                        aria-hidden="true"
                      >
                        <DesktopIcon
                          name={
                            isSorted
                              ? activeSortDir === "asc"
                                ? "arrow-up"
                                : "arrow-down"
                              : "chevrons-up-down"
                          }
                          size="xs"
                        />
                      </span>
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="ls-table__body">
          {sortedRows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="ls-table__empty">
                {emptyState ?? "暂无数据"}
              </td>
            </tr>
          ) : (
            sortedRows.map((row, rowIndex) => (
              <tr
                key={getRowKey(row, rowIndex)}
                data-clickable={onRowClick ? "true" : undefined}
                className="ls-table__row"
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((col) => {
                  const align = col.align ?? (col.numeric ? "right" : "left");
                  return (
                    <td
                      key={col.id}
                      data-align={align}
                      data-numeric={
                        col.numeric || align === "right" ? "true" : undefined
                      }
                      className={cn("ls-table__td", col.cellClassName)}
                    >
                      {col.cell(row, rowIndex)}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
