# FlightsMojo support knowledge base

> Source: distilled from the support team's real Zendesk templates and chat
> scripts (Jul 2026). ⚠ Values marked [VERIFY] need confirmation from the
> support team before launch. Edit this file + `docker compose restart bot`
> to update the bot's knowledge.

## Market scoping (important)
Fees, phone numbers, and payment rules below marked "India" apply ONLY to
flightsmojo.in customers. For UAE/USA/UK customers, do NOT quote India fees,
₹ amounts, or Indian phone numbers — if the market-specific value is not
listed here, hand off to a human instead of guessing.

## Booking confirmation timing
A booking made minutes ago can take up to 30 minutes for the confirmation to
generate. If payment succeeded but no ticket email after 30 minutes, look the
booking up with the booking-status tool (email + booking ID/PNR) and report
its real status. If status shows a problem or the customer is worried, hand off.

## E-ticket delays
If ticket issuance is delayed, the team raises the e-ticket request with
priority and shares it as soon as the airline returns it — typically by the
end of the same day. Apologize, reassure that the booking is being worked on
with priority, and hand off if the travel date is near.

## Baggage allowance
Standard allowance quoted by the team: 30 kg check-in + 7 kg cabin baggage
per passenger [VERIFY — varies by airline/fare; domestic fares are often
15 kg]. Always recommend confirming on the ticket and with the airline closer
to travel, as airline policies vary.

## Web check-in
- Opens on the airline's own website ~24 hours before departure (after 9:00 PM
  the previous day for most Indian carriers), using PNR + passenger last name.
- Steps: airline website/app → "Check-in" or "Manage Booking" → enter PNR +
  last name → select seats/add-ons → confirm.
- Boarding pass arrives by email 3-6 hours before departure, or download from
  the airline site / collect at the airport counter.
- Seat selection (and meals/add-ons) happens during web check-in, subject to
  availability and airline policy.
- Airline check-in links the team shares: IndiGo
  https://www.goindigo.in/flights/web-check-in.html · Air India
  https://travel.airindia.com/ssci/identification · Air India Express
  https://www.airindiaexpress.com/checkin-home
- If an airline's portal has a glitch (this happens), the customer should
  check in at the airport counter — airline staff will issue boarding passes.

## Group fares (Special Category Group Promotional Fare)
Many FlightsMojo bookings use group fares. Key rules:
- Strictly NON-REFUNDABLE and NON-CHANGEABLE once booked (dates, times, and
  passenger details cannot be modified).
- Passenger names appear on the airline's website only 12-24 hours before
  departure — this is normal; the customer will be notified by the airline
  when web check-in opens.
- Web check-in from 1 day before departure (after 9 PM), PNR + last name.
- No per-passenger fare breakup exists — the fare is a consolidated amount.
- GST details cannot be added to group-fare invoices (India).
- No-show on a group fare: no refund possible.

## Refunds — key policies (India)
- Refund Assurance highlights: full refund if the airline goes bankrupt or
  the aircraft is non-operational; refunds processed 24-48 hours after
  cancellation approval (customer-initiated cancellations have fees deducted
  and exclude non-refundable fares; airline-initiated cancellations are
  refundable even on non-refundable fares); flight delayed more than 3 hours
  and the customer declines to travel → full refund.
- Airline-cancelled flights: refund request goes to the airline; airline
  updates typically take 7-10 working days. FlightsMojo is not responsible
  for airline schedule changes/cancellations but processes the refund.
- Once a refund is initiated, banks take 5-7 working days to credit (bank
  ARN/RRN reference can be used to trace it with the bank).
- Failed/unconfirmed bookings where payment was captured: auto-refunded to
  the original payment method (24-48 hours to 5-7 working days depending on
  bank). If payment only reached "authorized" state, the bank auto-reverses.
- Fees that are NEVER refundable (India): convenience fee ₹300 per passenger
  [VERIFY], and platform charge ₹500 per passenger per sector [VERIFY —
  confirm which applies where]; these apply regardless of who cancelled.
- The bot must NEVER promise a specific refund amount or exact date. It may
  quote the standard timelines above. Any request to actually cancel, claim,
  or chase a specific refund → hand off.

## Payments (India site)
- International cards are NOT accepted — use an Indian bank card, Net
  Banking, or UPI.
- Payment failed but money debited: if no booking was generated, the amount
  auto-reverses to the source account; ask the customer to contact their
  issuing bank if it hasn't appeared within the standard 5-7 working days.
- Multiple payment attempts: only the successful one is attached to the
  booking; any excess captured amount auto-refunds — the issuing bank has the
  final status.

## Passport / name rules
- Passport with no surname: enter the first name as the last name (surname)
  when booking.
- Name corrections/changes on issued tickets → hand off (usually not allowed
  on group fares).

## Airline-initiated cancellations & disruption (IROP)
If the airline cancels or majorly disrupts a flight, a refund/compensation
claim needs ONE of these from the airline: a stamped boarding pass from the
airport, a split PNR reflecting the cancellation, or an official airline
email confirming cancellation with refund. Ask the customer to obtain and
share one of these, then hand off to the IROP team.

## Medical waiver requests
Documents required: admission slip, medical reports, discharge slip, proof of
blood relationship, and government ID. Fare rules still apply (group fares
remain non-refundable; any refund is subject to airline review). Collect
nothing in chat — direct the customer to email care@flightsmojo.in and hand off.

## Trip Shield
Optional paid protection allowing a refund request of base fare + airline
taxes (NOT convenience fees, surcharges, ancillaries, or the Trip Shield fee
itself) for specific emergencies. It is not insurance; refunds are
discretionary per the T&C: https://www.flightsmojo.in/flight/refundshield
Claims require supporting documents sent to care@flightsmojo.in → hand off.

## Contact (India)
NEVER share a phone number, WhatsApp number, or ask the customer to call or
message elsewhere — they are already talking to support right here. The only
contact channels you may mention are: this chat (you), and email
care@flightsmojo.in for anything that needs documents. For everything else,
help here or hand off to a human agent — do not redirect off this channel.
