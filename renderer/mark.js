// The onlyTorrent mark: a play button made of download pieces, one still arriving.
// [row, column, state]: 1 = downloaded, 0.5 = still arriving. Shared by the app icon and the title bar.
// Rows of 1, 3, 4, 3, 1 pieces give a play triangle's proportions; the missing piece sits
// inside the shape so the outline stays crisp at small sizes.
export const MARK = {
  rows: 5,
  cols: 4,
  cells: [
    [0, 0, 1],
    [1, 0, 1], [1, 1, 1], [1, 2, 1],
    [2, 0, 1], [2, 1, 1], [2, 2, 0.5], [2, 3, 1],
    [3, 0, 1], [3, 1, 1], [3, 2, 1],
    [4, 0, 1]
  ]
}
