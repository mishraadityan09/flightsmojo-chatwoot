# FlightsMojo FAQs (bot knowledge base)

> PLACEHOLDER CONTENT — replace each answer with your real policies.
> This file IS the bot's knowledge. Editing it changes what the bot says
> (restart the bot container after editing: docker compose restart bot).

## Ticket not received
If payment was debited but no ticket email arrived within 30 minutes, the
booking may still be processing. Ask the customer for their booking reference
(format FM-XXXXX) and email address, reassure them payment is safe, and hand
off to a human agent to check the booking status.

## Baggage allowance
Baggage allowance depends on the airline and fare type. It is shown on the
flight card during booking and on the ticket email. Domestic India flights
typically include 15kg check-in + 7kg cabin baggage on full-service and
low-cost carriers alike, but the ticket is the source of truth.

## Cancellation & refunds
Bookings can be cancelled from My Bookings. Refund amount depends on the
airline's fare rules and timing. The bot must NEVER promise a refund amount
or timeline — hand off to a human for any cancellation/refund request.

## Web check-in
Web check-in opens 24-48 hours before departure on the airline's own website
using the airline PNR from the ticket email.

## Payment failed but money deducted
If a payment fails but money was deducted, it is auto-refunded by the bank
within 5-7 working days. If a ticket was not generated, no booking exists.
Offer handoff to a human if the customer wants it investigated.

## Contact
Customers can also reach support via this chat anytime. Phone support hours:
9am-9pm IST.
