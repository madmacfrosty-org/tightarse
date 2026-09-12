import type { BooksResponse, BookPositionView } from "@tightarse/api-contract";

/**
 * Every book, and what has accumulated in it.
 *
 * #108's claim made visible: an account is a book, a category is a book, a loan
 * is a book, and one arithmetic gives each of them a position. What separates
 * them is a single property — whether that position is part of what the
 * household is worth.
 *
 * Positions arrive in one convention, negative meaning the book owes, so the
 * household's own figure is a plain sum of the rows above the line rather than
 * cash less cards by name.
 */

const money = (minor: number): string =>
  `${minor < 0 ? "−" : ""}£${(Math.abs(minor) / 100).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

function Rows({ books }: { books: readonly BookPositionView[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Book</th>
          <th>What it is</th>
          <th>Position</th>
        </tr>
      </thead>
      <tbody>
        {[...books]
          .sort((a, b) => a.position - b.position)
          .map((b) => (
            <tr key={b.book}>
              <td>{b.label}</td>
              <td>{b.nature}</td>
              <td>{money(b.position)}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

/**
 * Handed the response rather than fetching it.
 *
 * The dashboard's headline figure is this same `householdPosition`, so there is
 * one request and one number. Fetching separately here would have been a second
 * read of the whole ledger to answer a question already answered.
 */
export function Books({ data }: { data: BooksResponse | null }) {
  if (data === null) return <p className="subtle">Loading…</p>;

  // Defensive at a boundary, as the category picker is: a response without the
  // field is a panel with nothing to show, not a screen that throws.
  const all = data.books ?? [];
  const worth = all.filter((b) => b.rollsUp);
  const flows = all.filter((b) => !b.rollsUp);

  return (
    <section className="books">
      <h2>Every book</h2>
      <p className="note">
        An account, a category and a loan are the same kind of thing: a place
        amounts accumulate. Negative means the book owes.
      </p>

      <div className="book-group" aria-label="What the household is worth">
        <h3>What the household is worth</h3>
        <p className="note">
          These add up to the household&apos;s position. Money in an account
          counts; money owed on a card or a loan counts against.
        </p>
        <Rows books={worth} />
        <p>
          <strong>Household position: {money(data.householdPosition ?? 0)}</strong>
        </p>
      </div>

      <div className="book-group" aria-label="What has passed through">
        <h3>What has passed through</h3>
        <p className="note">
          Real figures, and not part of what the household is worth — spending
          is gone and income has already arrived somewhere that counts.
        </p>
        <Rows books={flows} />
      </div>
    </section>
  );
}
