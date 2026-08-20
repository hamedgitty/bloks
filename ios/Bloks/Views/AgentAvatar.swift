// The face everything renders: the uploaded photo when there is one, the
// pixel identity otherwise.
//
// Photos come over the same connection as everything else, bearer token
// included, which AsyncImage cannot send; hence the small loader. Loaded
// images are cached per (agent, upload time), so scrolling a long list
// does not refetch and a new upload busts the cache by changing the key.
import SwiftUI
import UIKit

struct AgentAvatar: View {
    @Environment(BloksStore.self) private var store
    let bot: Bot
    var size: CGFloat
    var tile: BlokTile = .circle

    @State private var photo: UIImage?

    var body: some View {
        Group {
            if let photo {
                Image(uiImage: photo)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            } else {
                BlokAvatar(
                    color: bot.avatarColor,
                    shape: bot.avatarShape,
                    expression: bot.avatarExpression,
                    size: size,
                    tile: tile
                )
            }
        }
        .task(id: "\(bot.id)-\(bot.avatarAt ?? 0)") {
            guard let at = bot.avatarAt else {
                photo = nil
                return
            }
            photo = await AvatarCache.shared.image(botId: bot.id, at: at, store: store)
        }
    }
}

/// One small cache for every avatar on screen. NSCache drops entries under
/// memory pressure, which is exactly the behavior wanted here.
final class AvatarCache {
    static let shared = AvatarCache()
    private let cache = NSCache<NSString, UIImage>()

    func image(botId: String, at: Double, store: BloksStore) async -> UIImage? {
        let key = "\(botId)-\(at)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        guard let data = try? await store.client.avatar(botId: botId),
              let image = UIImage(data: data)
        else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }
}
