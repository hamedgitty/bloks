/** A dismissed uncertain input remains visible to the person but must not
 * be treated as a sent message or replayed into an engine. A later native
 * confirmation makes it an ordinary joined input again. */
export function dismissedPreparation(message: { preparation?: { dismissed?: boolean; state: string } }): boolean {
  return message.preparation?.dismissed === true && message.preparation.state !== "joined";
}
