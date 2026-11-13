// A number per data object, so a memo over query results can tell their data apart by identity. `dataUpdatedAt` cannot:
// a query's data and its refetch can be written in the same millisecond. Structural sharing keeps an unchanged
// refetch's object, and so its number.
const dataIds = new WeakMap<object, number>();
let nextDataId = 0;

export function dataId(data: object | null | undefined): number {
	if (!data) return -1;
	let id = dataIds.get(data);
	if (id === undefined) dataIds.set(data, (id = nextDataId++));
	return id;
}
