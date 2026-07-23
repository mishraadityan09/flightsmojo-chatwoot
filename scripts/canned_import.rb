require "json"
data = JSON.parse(<<~'CANNEDJSON')
[
{
"short_code": "greet",
"content": "Welcome to FlightsMojo. My name is {{agent.name}}. How may I assist you today?"
},
{
"short_code": "ask-booking",
"content": "May I kindly request you to share your booking reference number or booking ID so I can assist you further?"
},
{
"short_code": "elaborate",
"content": "Please elaborate on your concerns for better assistance."
},
{
"short_code": "anything-else",
"content": "Apart from this, is there anything else I can help you with?"
},
{
"short_code": "close-day",
"content": "Thank you for choosing FlightsMojo. Wishing you a pleasant day ahead!"
},
{
"short_code": "close-night",
"content": "Thank you for choosing FlightsMojo. Wishing you a wonderful night ahead!"
},
{
"short_code": "close-idle",
"content": "As we have not received any response from your end, we are closing this chat for now. Please feel free to reconnect with us if you require any further assistance."
},
{
"short_code": "airline-glitch",
"content": "I would like to inform you that there seems to be a glitch on the airline's portal. We request you to please wait or connect with the airline directly for further assistance."
},
{
"short_code": "eticket-wait",
"content": "We would like to inform you that we have raised a request for your e-ticket. Kindly allow us until the evening. Once we receive it, we will share it with you promptly."
},
{
"short_code": "booking-30min",
"content": "We would like to inform you that the booking was made just a few minutes ago. We kindly request you to please allow up to 30 minutes for the confirmation to be generated."
},
{
"short_code": "priority-assurance",
"content": "We sincerely apologize for the delay and understand your concern, especially as your travel date is approaching.\n\nPlease be assured that your booking is being worked on with priority. You will receive an update on your ticket confirmation by the end of the day today. We appreciate your patience and request you to bear with us a little longer."
},
{
"short_code": "refund-stuck",
"content": "Upon checking, we found that your refund was initiated earlier but got stuck in the payment gateway. We have re-initiated the refund to the bank details shared with us.\n\nKindly allow 5-7 working days for the amount to reflect in your account. In some cases, it may take slightly longer depending on your bank's processing timeline."
},
{
"short_code": "fare-gone-refund",
"content": "We can see that the payment went through, but the booking couldn't be confirmed as the selected fare was no longer available at that time. The refund has already been initiated and will be credited back to your original payment method within 24-48 working hours, depending on your bank."
},
{
"short_code": "no-surname",
"content": "If your passport does not have a surname/last name, you may enter your first name as your last name (surname) while making the booking."
},
{
"short_code": "names-pending",
"content": "We would like to inform you that the passenger names have not yet been updated by the airline. Once the names are updated on the airline's system, you will receive a notification from the airline to proceed with web check-in."
},
{
"short_code": "webcheckin-done",
"content": "We would like to inform you that your web check-in has been successfully completed. Please find the attached boarding pass for your reference."
},
{
"short_code": "seat-webcheckin",
"content": "At the time of web check-in, you will be able to select your preferred seat, subject to availability and the airline's policies."
},
{
"short_code": "platform-charge",
"content": "We would like to inform you that a platform charge of INR 500 per passenger per sector applies, regardless of whether the cancellation is initiated by the passenger or the airline. This policy is mentioned on both your ticket and our website, and platform charges are non-refundable as per the policy."
},
{
"short_code": "irop-evidence",
"content": "In cases where the airline cancels or significantly disrupts a flight, they usually provide one of the following as confirmation:\n\n- A stamped boarding pass at the airport\n- A split PNR reflecting the cancellation\n- An official email from the airline confirming cancellation with full refund\n\nWe request you to kindly obtain any one of the above from the airline and share it with us, so we can raise the refund/compensation request on your behalf."
},
{
"short_code": "e-airline-cancelled",
"content": "Dear {{contact.name}},\n \nGreetings from Flights Mojo…!!\n \nWe sincerely regret any inconvenience caused to you.\n \nWith reference to your email, we would like to inform you that the flight was cancelled from the airline side due to the operational reason. Flights Mojo is not responsible for schedule changes or flight cancellations by the airlines. \n \nThe refund request is under process with the airline. Please note that the standard processing timeline for updates from the airline is 7-10 working days from the day after the request was raised. Rest assured, we are making every effort to expedite the process as much as possible.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-ask-for-booking-id",
"content": "Dear {{contact.name}},\n\nThank you for reaching out to us.\n \nWe request that you share your booking reference ID or registered email address for further assistance.\n\nFor any further assistance, please feel free to contact us.\n\nWarm regards,\nTeam Flights Mojo"
},
{
"short_code": "e-auto-reverse",
"content": "Dear {{contact.name}},\n \nGreetings from Flights Mojo…!!\n \nWe sincerely regret the inconvenience caused to you.\n \nRegarding your email, the transaction of INR 0000 was attempted from your account but was not received on our end.\n \nIf the amount has been debited from your bank account, it will be auto-reversed from the bank end to the original account used to make the payment.\n\nFor any further information or assistance, please feel free to contact us at +91-7699976888, WhatsApp at +91-9205544546, or email us at care@flightsmojo.in.\n \nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-baggage-allowance",
"content": "Dear {{contact.name}},\n\nThank you for contacting us regarding your booking.\n\nWe would like to inform you that the baggage allowance is as follows:\n\nCheck-in Baggage: 30 kg per passenger\nCabin Baggage: 7 kg per passenger\n\nThese allowances are standard, but we recommend confirming directly with the airline closer to your travel date, as policies may vary.\n\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-bank-details-for-old-txns",
"content": "Dear {{contact.name}},\n\nGreetings from Flights Mojo!\n\nWe sincerely regret the inconvenience you have faced regarding your refund.\n\nWe would like to inform you that the payment transaction exceeds 180 days, and due to banking and payment gateway restriction, we are unable to credit the refund to your original mode of payment.\n\nTo facilitate the refund process, we kindly request you to share your bank account details, including the following:\n• Account Holder Name\n• Bank Name\n• Account Number\n• IFSC Code\n• Government ID proof (PAN/Aadhar card)\n• Cancelled Cheque\n\nOnce we receive these details, we will promptly process the refund amount received from the airline via direct bank transfer.\n\nFor any further information or assistance, please feel free to contact us.\n\nWe appreciate your patience and cooperation.\n\nThanks and regards,\nTeam Flights Mojo"
},
{
"short_code": "e-boarding-pass",
"content": "Dear {{contact.name}},\n\nYou will receive your boarding pass 3-6 hours prior to departure via email after proceeding with web check-in by the airline. Alternatively, you can download it from the airline's website or collect it at the airport counter.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-booking-confirmation",
"content": "Dear {{contact.name}},\n\nGreetings from Flights Mojo…!!\n\nWe sincerely regret the inconvenience caused to you.\n\nWe would like to inform you that your reservation is confirmed with us. For more information, you can go through the attachment.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-booking-in-progress",
"content": "Dear {{contact.name}},\n \nGreetings from Flights Mojo…!!\n\nWe sincerely regret the inconvenience caused to you. \n\nWe would like to inform you that your booking is in progress. Please wait for some time for the updated status.\n  \nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-booking-not-generated",
"content": "Dear {{contact.name}},\n\nThis is regarding your payment inquiry. Upon checking our records, we confirm that a payment attempt was made; however, it was automatically refunded by the payment gateway, and no booking was generated.\n\nWe are pleased to inform you that the refund has been successfully processed from our end to the same mode of payment used at the time of payment.\n\nPlease find below the mentioned refund details:\n• Refund Amount: INR 3,789\n• Refund Date: 12th of October '25\n• Bank ARN/RRN: 856243492724\n\nIf the refund is not reflecting in your account, we kindly request you to contact your respective bank with the provided ARN/RRN to track the transaction. \n\nPlease note that banks may take 5-7 working days to process the credit, and in some cases, it may take slightly longer depending on your bank’s processing schedule.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-call-us",
"content": "Dear {{contact.name}},\n\nGreetings from Flights Mojo…!!\n\nWe would like to inform you, To expedite the resolution of your concern, we recommend calling our customer support directly at 0124-6932000. Our team will assist you promptly and provide the necessary information regarding your booking.\n\nThank you for your understanding.\n\nBest regards,\nFlightsMojo"
},
{
"short_code": "e-chargeback-dispute-raised",
"content": "Dear {{contact.name}},\n\nGreetings from Flights Mojo…!!\n\nWith reference to your email, we understand that you have raised a chargeback/dispute with your bank for the amount of INR 9,300.\n\nHence, we would like to inform you that once a chargeback/dispute is raised, any transaction can be processed via the dispute channel only i.e, between the customer's bank and the merchant's bank.\n\nTherefore, we would request you to kindly contact the card dispute division of the respective issuing bank for any further assistance in this regard.\n\nPlease be noted raising disputes against the transaction makes the bank investigate the matter internally within the departments and as well as the Merchant bank to provide resolution to the customers.\n\nWe would like to assure you that the bank's queries will be properly answered by the finance department via the dispute proceedings.\n\nFor any further information or assistance, please feel free to contact us at +91-7699976888, WhatsApp at +91-9205544546, or email us at care@flightsmojo.in.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-contact-groupdesk",
"content": "Dear {{contact.name}},\n \nGreetings from Flights Mojo!\n \nWe would like to inform you that we have not received any intimation regarding the cancellation of your booking from the airline. To assist you further, we kindly request you to share written confirmation of the cancellation and refund from the airline.\n \nWe recommend reaching out to the airline directly at groupdesk@spicejet.com and requesting the canceled split PNR. Once you obtain the canceled split PNR or written confirmation, we will be able to claim the refund on your behalf.\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-convenience-fee",
"content": "Dear {{contact.name}},\n\nGreetings from Flights Mojo…!!\n\nWe regret any confusion regarding the refund process for your bookings. As per our policy and telephone conversation, the amount of Rs. 300 deducted for each passenger is a convenience fee, which is non-refundable. We understand that the cancellations were due to factors like flight cancellations or schedule changes by the airline, and we sincerely apologize for any inconvenience caused.\n\nHowever, please note that the convenience fee is applicable regardless of the reason for the cancellation, and as such, it is not refundable.\n\nWe appreciate your understanding and cooperation. \n\nFor any further information or assistance, please feel free to contact us at +91-7699976888, WhatsApp at +91-9205544546, or email us at care@flightsmojo.in.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-death-deny",
"content": "Dear {{contact.name}},\n\nThank you for writing to Flights Mojo.\n\nWe are deeply sorry for your loss and extend our heartfelt condolences to the family during this difficult time.\n\nWe would like to inform you that we are not in a position to provide you refund of your booking as your reservation is in a Special Category Group Promotional Fare. The fare once booked, cannot be changed, or cancelled. This is a highly restricted fare and completely non-refundable and non-changeable.\n\nFurther, we request you to contact the airline directly for refund under medical issue and provide required documents to the airline, as the airline handle such cases.\n\nFor any further information or assistance, please feel free to contact us at +91-7699976888, WhatsApp at +91-9205544546, or email us at care@flightsmojo.in.\n\nThank you for your patience and understanding.\n\nRegards,\nTeam FlightsMojo"
},
{
"short_code": "e-details-shared-resolved",
"content": "Dear {{contact.name}},\n\nGreetings from Flights Mojo…!!\n\nThank you for writing to us.\n\nWe would like to inform you that we have shared your case with the concerned team. It is in the process of being resolved.\n\nPlease bear with us as we work towards finding you a resolution.\n\nWe thank you for your time and patience.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-elaborate-concern",
"content": "Dear {{contact.name}},\n\nGreetings from Flights Mojo…!!\n\nThank you for reaching out to us.\n\nKindly share your specific query along with the Booking ID and registered email address used during the reservation, so we can check the details and assist you promptly.\n\nLooking forward to your response.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-fare-breakup",
"content": "Dear {{contact.name}},\n  \nWe regret to inform you that as per our policy for group fares under Special Category Group Promotional Fare, a passenger-wise price breakup is not available. The fare is provided as a consolidated amount for the entire booking.\n  \nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-group-fare-policy",
"content": "Dear {{contact.name}}, \n\nWe would like to inform you that your booking is confirmed and the reservation falls under a Special Category Group Promotional Fare, which will be visible on the airline’s website 12-24 hours before departure. You can complete web check-in using your PNR and last name on the airline's website starting 1 day before departure, after 9:00 PM.\n\nOnce web check-in is completed, you will receive your boarding pass 3-6 hours before departure via email. Alternatively, you can download it from the airline’s website or collect it at the airport counter.\n\nIMPORTANT INFORMATION:\n•The fare you selected is a Special Category Group Promotional Fare.\n• Web Check-in for this ticket can be done a day before the journey.\n• Seat selection, meal preferences, and add-ons can be chosen during web check-in.\n• Please reconfirm the flight timings and schedule at least 24-48 hours before departure.\n• The fare, once booked, cannot be changed or cancelled. This is a highly restricted fare and completely non-refundable and non-changeable.\n• However, as it is a group fare, your name will reflect on the airline’s website only 12-24 hours before departure.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-gst-invoice-denial",
"content": "Dear {{contact.name}},\n\nThank you for your request.\n\nAs the booking was made under a group fare, GST cannot be applied to this fare as per the terms and conditions. We regret that we are unable to update the invoice with customer's GST details.\n\nFurther, please find the attached invoice for your booking below, provided for your reference and records.\n\nBest regards,\nFlights Mojo"
},
{
"short_code": "e-interim",
"content": "Dear {{contact.name}},\n\nWe would like to inform you that we are in ongoing communication with the relevant team to address the issue on priority.\n\nWe kindly ask for your patience as we work on resolving this matter. Rest assured, we will provide you with an update as soon as possible.\n\nWe appreciate your understanding and patience.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-interim-refund",
"content": "Dear {{contact.name}},\n \nGreetings from Flights Mojo!\n \nWe appreciate your patience and apologize for any inconvenience caused during this process.\n \nWe understand the importance of resolving your refund request promptly. Our team is actively working on your case, and we assure you that your concern is a priority for us.\n\nThe details have been forwarded to the concerned team, and kindly allow us some time.\n\nFor any further information or assistance, please feel free to contact us at +91-7699976888, WhatsApp at +91-9205544546, or email us at care@flightsmojo.in.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-international-card",
"content": "Dear {{contact.name}},\n \nGreetings from Flights Mojo!\n \nWe regret to inform you that we are currently unable to accept international cards for payments. We kindly request you to use a card issued by an Indian bank or consider using Net Banking or UPI for your booking.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-invoice-attached",
"content": "Dear {{contact.name}},\n\nWarm greetings from Flights Mojo!\n\nWe hope this message finds you well. Please find attached the invoice for your booking, provided for your reference and records.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-irop-refund-possible",
"content": "Dear {{contact.name}},\n \nGreetings from Flights Mojo!\n \nWe sincerely apologize for any inconvenience caused.\n \nWith reference to your email, we would like to inform you that your flight was cancelled by the airline due to operational reasons. We had requested an alternate arrangement on your behalf, but unfortunately, the airline declined this request.\n \nAt this point, only a refund can be processed with your confirmation. Please let us know if you wish to proceed.\n \nFor any further information or assistance, please feel free to contact us at +91-7699976888, WhatsApp at +91-9205544546, or email us at care@flightsmojo.in.\n \nThank you for your understanding.\n \nBest regards,\nTeam Flights Mojo"
},
{
"short_code": "e-medical-issue",
"content": "Dear {{contact.name}},\n \nGreetings from Flights Mojo…!!\n \nWe would like to inform you that we are not in a position to provide you refund of your booking as your reservation is in a Special Category Group Promotional Fare. The fare once booked, cannot be changed, or cancelled. This is a highly restricted fare and completely non-refundable and non-changeable.\n \nFurther, we request you to contact the airline directly for refund under medical issue, the airline handle such cases.\n \nFor any further information or assistance, please feel free to contact us at +91-7699976888, WhatsApp at +91-9205544546, or email us at care@flightsmojo.in.\n \nThank you for your patience and understanding.\n \nRegards,\nTeam FlightsMojo"
},
{
"short_code": "e-mode-of-payment",
"content": "Dear {{contact.name}},\n\nGreetings from Flights Mojo!\n\nWe regret to inform you that we are currently unable to accept international cards for payments. We kindly request you to use a card issued by an Indian bank or consider using Net Banking or UPI for your booking.\n\nFor any further information or assistance, please feel free to contact us at +91-7699976888, WhatsApp at +91-9205544546, or email us at care@flightsmojo.in.\n\nThank you for choosing Flights Mojo.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-multiple-payment-attempts",
"content": "Dear {{contact.name}},\n \nGreetings from Flights Mojo!\n \nThank you for reaching out to us.\n \nWith reference to your email, we would like to inform you that 1st payment was attempted from your end which was a failed transaction with payment ID pay_PgEWXlNweiAtPr.\n \nOn the same note, we would like to confirm you that the 2nd transaction was successful and the same is updated on the booking ID 808601 under payment ID pay_PgEYFwozyDWgwC.\n \nIn case any excess amount has been debited, please contact the issuing bank for more information regarding the transaction status.\n \nFor any further information or assistance, please feel free to contact us at +91-7699976888, WhatsApp at +91-9205544546, or email us at care@flightsmojo.in.\n \nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-no-response-of-refund-req",
"content": "Dear {{contact.name}},\n\nGreetings from Flights Mojo!\n\nWe would like to inform you that we have initiated a refund request with the airline on your behalf, and it is currently under process as we await a response from the airline.\n\nPlease note that the standard processing timeline for updates from the airline is 7-10 working days from the day after the request was raised. Rest assured, we are making every effort to expedite the process as much as possible.\n\nWe appreciate your patience and understanding. \n\nIf you need further assistance, please feel free to contact us at +91-7699976888, WhatsApp at +91-9205544546, or email us at care@flightsmojo.in.\n\nThanks and regards,\nTeam Flights Mojo"
},
{
"short_code": "e-non-changeabl-non-refundable",
"content": "Dear {{contact.name}},\n\nWe would like to inform you that your reservation has been made under a Special Category Group Promotional Fare.\n\nAs per the applicable fare rules, this booking is highly restricted and once confirmed, it is non-refundable and non-changeable.\n\nWe request you to kindly take note of the same.\n\nFor any further information or assistance, please feel free to contact us.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-no-show-refund-deny",
"content": "Dear {{contact.name}},\n\nThank you for reaching out to us.\n\nWe regret to inform you that your booking was made under a Special Category Group Promotional Fare. As per the terms and conditions of this fare type, the ticket price, including applicable taxes, is strictly non-refundable and non-cancellable.\n\nAdditionally, your booking has been marked as a no-show in the airline's system, and unfortunately, no refund can be processed in such cases.\n\nWe sincerely appreciate your understanding as this matter falls under the airline's policies and is beyond our control.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-payment-details",
"content": "Dear {{contact.name}},\n \nGreetings from Flights Mojo...!!\n \nWith reference to your email, we would like to inform you that we are unable to trace the transaction details from the information provided by you.\n \nThus, we would request you to kindly share the below details with us to enable us to assist you further:\n \nDate and time of the transaction:\nCurrency & Amount deducted:\nMode of Payment (UPI/Online card payment/Airport payment through card swipe/Net banking):\nScreenshot of the transaction reflecting payment made towards Flights Mojo:\nCard details: First 06 and last 04 digits (if payment made through card):\nRegistered contact number and e-mail address used in the reservation:\nTransaction details (Transaction ID or Order ID):\n \nFor any further information or assistance, please feel free to contact us at +91-7699976888, WhatsApp at +91-9205544546, or email us at care@flightsmojo.in.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-payment-failed",
"content": "Dear {{contact.name}},\n\nWe sincerely regret the inconvenience caused to you.\n\nWith reference to your email, we would like to inform you that the transaction of INR 7,088 was attempted from your account however same was unsuccessful.\n\nIn case the amount has been debited, please contact the issuing bank for more information regarding the transaction status.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-payments-attempts",
"content": "Dear {{contact.name}},\n \nGreetings from Flights Mojo!\n \nThank you for reaching out to us.\n \nWith reference to your email, we would like to inform you that 1st payment was attempted from your end which was a failed transaction with payment ID pay_PofGA1ha22MsWW.\n \nOn the same note, we would like to confirm you that the 2nd transaction was successful and the same is updated on the booking ID 855660 under payment ID pay_PofI4KaQYfao3R.\n \nIn case any excess amount has been debited, please contact the issuing bank for more information regarding the transaction status.\n \nFor any further information or assistance, please feel free to contact us at +91-7699976888, WhatsApp at +91-9205544546, or email us at care@flightsmojo.in.\n \nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-published-fare-xxln-rsdk",
"content": "Dear {{contact.name}},\n\nThank you for reaching out to us.\n\nWe would like to inform you that this booking has been made under published fares. For any cancellation or modifications to your booking, we kindly request you to directly contact the airline as they handle such requests for published fare bookings.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-refund-assurance-policy",
"content": "Dear {{contact.name}},\n\nGreetings from Flights Mojo!\n\nWe would like to provide you with an overview of our refund policy for better clarity:\n\n•Protection Against Airline Bankruptcy\nIn the unforeseen event of flight cancellation due to airline bankruptcy or the aircraft becoming non-operational, you are fully covered, and a full refund will be processed.\n\n•Instant Refunds for Cancellations\nReceive your refund within 24-48 hours, regardless of whether the cancellation is initiated by you or the airline. For customer-initiated cancellations, applicable fees will be deducted, and non-refundable bookings will be excluded. If the airline cancels the flight, even non-refundable bookings are eligible for a refund.\n\n•Proactive Refund for Delays\nIf your flight is delayed by more than 3 hours and you choose not to accept the delay, we guarantee a full refund, ensuring your schedule and comfort remain our priority.\n\n For any further clarification or assistance, feel free to contact us at +91-7699976888, WhatsApp +91-9205544546, or email care@flightsmojo.in.\n\nThanks and regards,\nTeam Flights Mojo"
},
{
"short_code": "e-refund-failed-by-payu",
"content": "Dear {{contact.name}},\n \nGreetings from Flights Mojo!\n \nWe would like to inform you that your refund was previously processed. However, due to a technical error with the payment gateway, it was not successfully credited to your account.\n \nWe sincerely apologize for any inconvenience this may have caused. We have now successfully reprocessed the refund to your original mode of payment.\n \nRefund Details:\n• Refund Amount: INR 2,272\n• Refund Date: 31st January 2025\n• Bank ARN/RRN: 503111983702\n \nIf the refund is not reflecting in your account, we kindly request you to contact your respective bank with the provided details to claim your refund.\n \nFor any further information or assistance, please feel free to contact us at +91-7699976888, WhatsApp at +91-9205544546, or email us at care@flightsmojo.in.\n \nThanks and regards,\nTeam Flights Mojo"
},
{
"short_code": "e-refund-processed",
"content": "Dear {{contact.name}},\n\nGreetings from Flights Mojo…!!\n\nWe sincerely regret the inconvenience caused to you.\n\nWe would like to confirm that your refund has been successfully processed from our end to the original mode of payment used at the time of booking. \n\nKindly wait 5-7 working days for the refund to reflect in your account, as per the standard processing timeline. In some cases, it may take slightly longer depending on your bank’s processing schedule.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-refund-request-raised",
"content": "Dear {{contact.name}},\n\nWe would like to inform you that we have initiated a refund request with the airline on your behalf. We will share an update as per the airline's response.\n\nPlease note that the standard processing timeline for updates from the airline is 7-10 working days from the day after the request was raised. Rest assured, we are making every effort to expedite the process as much as possible.\n\nWe appreciate your patience and understanding during this process.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-reminder-sent",
"content": "Dear {{contact.name}},\nWe understand your concern and sincerely apologize for the delay.\n\nPlease be informed that we have already raised the refund request on your behalf, and it is currently pending with the airline's group desk/supplier team. The delay is from their end, and we are actively following up to expedite the process.\n\nWe have also sent them a reminder and will share any update as soon as we receive the response. We appreciate your continued patience and understanding in the meantime.\n\nThanks and regards,\nTeam Flights Mojo"
},
{
"short_code": "e-request-declined",
"content": "Dear {{contact.name}},\n\nGreetings from Flights Mojo!\n\nWe would like to inform you that we have initiated a refund request with the airline on your behalf. However, the request has been declined by the airline. Please check the screenshot for your reference. \n\nTo proceed further, we kindly request you to obtain written confirmation of the refund via email from SpiceJet and share it with us. Once we receive this confirmation, we will promptly review the details and update you accordingly.\n\nFor any further information or assistance, please feel free to contact us at +91-7699976888, WhatsApp at +91-9205544546, or email us at care@flightsmojo.in.\n\nThanks and regards,\nTeam Flights Mojo"
},
{
"short_code": "e-review-link-mail",
"content": "Dear {{contact.name}},\n\nThank you for choosing Flights Mojo for your travel needs! We hope you had a seamless and pleasant experience with us.\n\nYour feedback is extremely important to us as it helps us improve and continue to provide excellent service. If you’re happy with your experience, we’d greatly appreciate it if you could take a moment to share a 5-star review.\n\nYour positive review will not only encourage our team but also help other customers make informed decisions.\n\nYou can share your feedback here: https://g.page/r/Ce4ktOYAEMFnEAE/review\n\nThank you for your time and support! We look forward to serving you again soon.\n\nBest regards,\nTeam Flights Mojo"
},
{
"short_code": "e-terminal-info",
"content": "Dear {{contact.name}},\n\nGreetings from Flights Mojo!\n\nWe would like to inform you that your flight is scheduled to depart from Delhi Terminal 3  gate 26T as per the airline's information. However, we recommend reconfirming the terminal 12–24 hours before departure, as it is subject to change by the airline.\n\nFor any further assistance, feel free to contact us at +91-7699976888, WhatsApp us at +91-9205544546, or email us at care@flightsmojo.in.\n\nThank you for choosing Flights Mojo.\n\nWarm regards,\nTeam Flights Mojo"
},
{
"short_code": "e-utr",
"content": "Dear {{contact.name}},\n\nThank you for writing to Flights Mojo!\n\nWith reference to your email, we have tried reaching you at the registered contact number. However, we could not establish a connection.\n\nMay we request you kindly share your alternate contact number and a convenient time to enable us to get in touch with you?\n\nFor any further information or assistance, please feel free to contact us at  WhatsApp at +91-9205544546, or email us at care@flightsmojo.in.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-web-check-in-process",
"content": "Dear {{contact.name}},\n\nGreetings from Flights Mojo!\n\nWeb check-in allows you to check in for your flight online before arriving at the airport. You can complete web check-in using your PNR and last name on the airline's website starting 1 day before departure, after 9:00 PM.\n\nHere’s how to complete web check-in:\n• Visit the airline's website or mobile app.\n• Locate the 'Check-in' or 'Manage Booking' section.\n• Enter your PNR number and Last Name.\n• Follow the prompts to select your seat, add-ons, and confirm your check-in.\n\nBoarding Pass:\nOnce web check-in is completed, your boarding pass will be sent to your email 3-6 hours before departure. Alternatively, you can download it from the airline's website or collect it at the airport counter.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-written-confirmation",
"content": "Dear {{contact.name}},\n  \nWe would like to inform you that we have not received any intimation regarding the cancellation of your booking from the airline side.\n \nFurther, we request you to share the written confirmation of cancellation and refund from the airline to assist you.\n \nWe will get back to you with a positive update.\n\nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-tripshield-documents",
"content": "Dear {{contact.name}},\n \nGreetings from Flights Mojo!\n \nThis is regarding your recent request to cancel your booking under the Trip Shield policy. As informed during our call, we require the relevant supporting documents to proceed with the cancellation as per policy guidelines.\n \nSince you mentioned that you are unable to travel due to official commitments related to your defence duties, we kindly request you to share the necessary proof (e.g., official letter/order/ID with travel restriction details) at the earliest.\n \nPlease send the required documents to: care@flightsmojo.in\n \nPlease note that we will be able to process your cancellation request only after receiving the appropriate documentation.\n \nShould you need any assistance or clarification, feel free to contact us. We are here to help.\n \nThank you for your cooperation."
},
{
"short_code": "e-air-india-webcheck-in",
"content": "Dear {{contact.name}},\n \nGreetings from Flights Mojo…!!\n \nPlease complete your web check-in for your Air India group fare booking using the link below:\n \nWeb Check-in Link:\nhttps://travel.airindia.com/ssci/identification\n \nStep-by-Step Instructions for Web Check-In\n- Kindly click on the provided link.\n- Select Booking Reference.\n- Enter the PNR and last name.\n- Follow the prompts to select your seat, add-ons, and confirm your check-in.\n \nFor any further information or assistance, please feel free to contact us at +91-7699976888, WhatsApp at +91-9205544546, or email us at care@flightsmojo.in.\n \nThanks and regards,\nTeam Flightsmojo"
},
{
"short_code": "e-denied-boarding",
"content": "Dear {{contact.name}},\n\nThank you for reaching out to us.\n\nWith reference to your email, we regret the inconvenience you have faced. We would like to inform you that the airport staff did not allow you to enter, and the agency is not authorized in this matter. This falls under the airline’s policy, so we kindly request you to connect directly with the airline for any further action.\n \nIf the airline agrees to provide you with a refund, please obtain written confirmation from them and share it with us. Once received, we will be able to assist you further with the refund process.\n\nThank you for your understanding.\n\nWarm regards,\nTeam Flights Mojo"
},
{
"short_code": "e-web-checkin-with-auto-assign-seat",
"content": "Dear {{contact.name}},"
}
]
CANNEDJSON
account = Account.first!
created = updated = 0
data.each do |r|
  cr = CannedResponse.find_or_initialize_by(account: account, short_code: r["short_code"])
  cr.new_record? ? created += 1 : updated += 1
  cr.content = r["content"]
  cr.save!
end
puts "canned: #{created} created, #{updated} updated, total #{account.canned_responses.count}"
