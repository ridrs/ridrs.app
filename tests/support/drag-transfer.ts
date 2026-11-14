// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `dataTransfer` of one drag, as the web view hands it to every event of the drag: the data
 * the source sets on `dragstart`, the types a target sees while it hovers, and the effects. The
 * headless DOM has no `DataTransfer`, so the steps hand this object to each event of a drag.
 */
export interface DragTransfer {
  dropEffect: string;
  effectAllowed: string;
  readonly types: readonly string[];
  readonly files: readonly File[];
  setData(type: string, data: string): void;
  getData(type: string): string;
  clearData(type?: string): void;
}

export function dragTransfer(): DragTransfer {
  const data = new Map<string, string>();
  return {
    dropEffect: 'none',
    effectAllowed: 'all',
    get types() {
      return [...data.keys()];
    },
    files: [],
    setData: (type, value) => {
      data.set(type.toLowerCase(), value);
    },
    getData: (type) => data.get(type.toLowerCase()) ?? '',
    clearData: (type) => {
      if (type === undefined) data.clear();
      else data.delete(type.toLowerCase());
    },
  };
}
