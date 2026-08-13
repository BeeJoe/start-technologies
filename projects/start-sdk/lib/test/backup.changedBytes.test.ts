import { parseRsyncTransferredBytes } from '../backup/Backups'

describe('scheduled backup rsync statistics', () => {
  test('parses transferred bytes from structured stats', () => {
    expect(
      parseRsyncTransferredBytes(
        'Number of files: 42\nTotal transferred file size: 1,234,567 bytes\n',
      ),
    ).toBe(1_234_567)
  })

  test('returns unknown when structured stats are unavailable', () => {
    expect(
      parseRsyncTransferredBytes('custom backup hook completed\n'),
    ).toBeNull()
  })

  test('handles a stats line assembled from output chunks', () => {
    const chunks = ['Total transferred file ', 'size: 99 bytes\n']
    expect(parseRsyncTransferredBytes(chunks.join(''))).toBe(99)
  })
})
