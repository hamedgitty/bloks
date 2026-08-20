// GENERATED FILE. Do not edit.
//
// Written by ios/tools/generate-bitmaps.mjs from:
//   src/components/Avatar.tsx  (BITMAPS)
//   src/lib/mascot.ts          (BLOK_COLORS, BLOK_SHAPES, BLOK_EXPRESSIONS)
//
// Regenerate with:  node ios/tools/generate-bitmaps.mjs
import Foundation

/// The eight silhouettes. '#' is a body pixel, 16 rows of 16.
enum BlokShape: String, CaseIterable, Codable {
    case star
    case burst
    case diamond
    case bit
    case triangle
    case cloud
    case drop
    case invader

    /// Stable fallback for an agent made before shapes existed: hash the
    /// key so every agent gets its own silhouette without a migration.
    /// Mirrors shapeForBot() in src/lib/mascot.ts.
    static func forAgent(id: String?, name: String, declared: String?) -> BlokShape {
        if let declared, let shape = BlokShape(rawValue: declared) { return shape }
        let key = (id?.isEmpty == false ? id : nil) ?? name
        var hash: Int32 = 0
        for scalar in key.unicodeScalars {
            hash = hash &* 31 &+ Int32(truncatingIfNeeded: Int(scalar.value))
        }
        let all = BlokShape.allCases
        return all[Int(hash.magnitude) % all.count]
    }
}

enum BlokExpression: String, CaseIterable, Codable {
    case deadpan
    case friendly
    case focused
    case thinking
    case excited
    case sleepy
    case surprised
    case skeptical
    case worried
    case mischievous
}

enum BlokColor: String, CaseIterable, Codable {
    case green
    case blue
    case red
    case orange
    case purple
    case cyan
    case pink
    case yellow
    case teal
    case coral

    static func named(_ raw: String) -> BlokColor {
        BlokColor(rawValue: raw) ?? .blue
    }
}

struct BlokBitmap {
    let rows: [String]
    /// Where the face sits, in grid rows from the top of the 16x16 box.
    let faceY: Double
}

enum BlokArt {
    /// The 16x16 grid the creatures are drawn on.
    static let grid = 16
    /// The creature box inside the 100x100 tile, and its inset.
    static let box: Double = 72
    static let boxOffset: Double = (100 - 72) / 2
    static let cell: Double = 72 / 16

    static let bitmaps: [BlokShape: BlokBitmap] = [
        .star: BlokBitmap(
            rows: [
            ".......##.......",
            ".......##.......",
            "......####......",
            "......####......",
            ".....######.....",
            "....########....",
            "..############..",
            "################",
            "################",
            "..############..",
            "....########....",
            ".....######.....",
            "......####......",
            "......####......",
            ".......##.......",
            ".......##.......",
            ],
            faceY: 7.5
        ),
        .burst: BlokBitmap(
            rows: [
            ".......##.......",
            ".......##.......",
            "..#....##....#..",
            "..##.######.##..",
            "...##########...",
            "...##########...",
            "..############..",
            "################",
            "################",
            "..############..",
            "...##########...",
            "...##########...",
            "..##.######.##..",
            "..#....##....#..",
            ".......##.......",
            ".......##.......",
            ],
            faceY: 7.5
        ),
        .diamond: BlokBitmap(
            rows: [
            "................",
            ".......##.......",
            "......####......",
            ".....######.....",
            "....########....",
            "...##########...",
            "..############..",
            ".##############.",
            ".##############.",
            "..############..",
            "...##########...",
            "....########....",
            ".....######.....",
            "......####......",
            ".......##.......",
            "................",
            ],
            faceY: 7.5
        ),
        .bit: BlokBitmap(
            rows: [
            "................",
            "................",
            "................",
            "................",
            "...##########...",
            "..############..",
            ".##############.",
            ".##############.",
            ".##############.",
            ".##############.",
            "..############..",
            "...##########...",
            "................",
            "................",
            "................",
            "................",
            ],
            faceY: 7.5
        ),
        .triangle: BlokBitmap(
            rows: [
            "................",
            "................",
            "................",
            ".....######.....",
            "....########....",
            "....########....",
            "...##########...",
            "...##########...",
            "..############..",
            "..############..",
            ".##############.",
            ".##############.",
            "..############..",
            "................",
            "................",
            "................",
            ],
            faceY: 8.5
        ),
        .cloud: BlokBitmap(
            rows: [
            "................",
            "................",
            "................",
            "....#####.......",
            "...#######.###..",
            "..#############.",
            ".##############.",
            ".##############.",
            ".##############.",
            ".##############.",
            "..############..",
            "...##########...",
            "................",
            "................",
            "................",
            "................",
            ],
            faceY: 7.5
        ),
        .drop: BlokBitmap(
            rows: [
            "................",
            ".......##.......",
            ".......##.......",
            "......####......",
            "......####......",
            ".....######.....",
            "....########....",
            "...##########...",
            "..############..",
            "..############..",
            "..############..",
            "...##########...",
            "....########....",
            ".....######.....",
            "................",
            "................",
            ],
            faceY: 9.5
        ),
        .invader: BlokBitmap(
            rows: [
            "................",
            "................",
            "...#........#...",
            "....#......#....",
            "...##########...",
            "..############..",
            ".##############.",
            ".##############.",
            ".##############.",
            ".##.########.##.",
            ".##.########.##.",
            "....##....##....",
            "...##......##...",
            "................",
            "................",
            "................",
            ],
            faceY: 7
        ),
    ]

    static let colorHex: [BlokColor: UInt32] = [
        .green: 0x3BC76B,
        .blue: 0x4C86F5,
        .red: 0xF04438,
        .orange: 0xFF9432,
        .purple: 0xA468F7,
        .cyan: 0x3FC3F0,
        .pink: 0xF972B6,
        .yellow: 0xFFD93B,
        .teal: 0x2EC9A9,
        .coral: 0xFF7A63,
    ]
}
