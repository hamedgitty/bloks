// Debug only: every agent's avatar, big, in one grid.
//
// This exists because the avatar port is the single most likely place to
// produce something that looks plausible and is not the same creature. The
// grid is laid out to match the inspection overlay used against the web
// client, so the two screenshots can be put side by side and diffed by eye
// without hunting through a sidebar.
//
// Not compiled into a release build.
#if DEBUG
import SwiftUI

struct AvatarGallery: View {
    @Environment(BloksStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private let columns = [GridItem(.adaptive(minimum: 160), spacing: 18)]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 18) {
                    ForEach(store.bots) { bot in
                        VStack(spacing: 6) {
                            BlokAvatar(
                                color: bot.avatarColor,
                                shape: bot.avatarShape,
                                expression: bot.avatarExpression,
                                size: 150
                            )
                            Text(bot.name)
                                .font(.caption2)
                                .multilineTextAlignment(.center)
                            Text("\(bot.color) / \(bot.avatarShape.rawValue) / \(bot.avatarExpression.rawValue)")
                                .font(.system(size: 9))
                                .foregroundStyle(.secondary)
                        }
                        .frame(width: 160)
                    }
                }
                .padding(24)

                Divider()

                // Every expression on one shape, so a regression in a face
                // that no seeded agent happens to wear still shows up.
                Text("All expressions").font(.caption).padding(.top, 12)
                LazyVGrid(columns: columns, spacing: 18) {
                    ForEach(BlokExpression.allCases, id: \.self) { expression in
                        VStack(spacing: 6) {
                            BlokAvatar(color: .blue, shape: .star, expression: expression, size: 150)
                            Text(expression.rawValue).font(.system(size: 9))
                        }
                        .frame(width: 160)
                    }
                }
                .padding(24)

                Divider()

                // Every silhouette, so a bitmap that regenerated wrong is
                // visible without needing an agent that uses it.
                Text("All shapes").font(.caption).padding(.top, 12)
                LazyVGrid(columns: columns, spacing: 18) {
                    ForEach(BlokShape.allCases, id: \.self) { shape in
                        VStack(spacing: 6) {
                            BlokAvatar(color: .green, shape: shape, expression: .deadpan, size: 150)
                            Text(shape.rawValue).font(.system(size: 9))
                        }
                        .frame(width: 160)
                    }
                }
                .padding(24)
            }
            .background(Color.white)
            .navigationTitle("Avatars")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
#endif
