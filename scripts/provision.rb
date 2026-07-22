# Idempotent provisioning for FlightsMojo support inboxes (launch sites).
# Run:  docker compose exec -T rails bundle exec rails runner - < scripts/provision.rb
# Safe to re-run: finds-or-creates inboxes, (re)applies ticket-style settings,
# attaches the agent bot, adds all agents. Prints "id|name|website_token" per
# site — those tokens go into the web app env (NEXT_PUBLIC_CHATWOOT_TOKEN_*).

SITES = [
  ['FlightsMojo India', 'https://www.flightsmojo.in'],
  ['FlightsMojo UAE',   'https://www.flightsmojo.ae'],
  ['FlightsMojo USA',   'https://www.flightsmojo.com'],
  ['FlightsMojo UK',    'https://www.flightsmojo.co.uk'],
].freeze

WIDGET_COLOR = '#ef6614'.freeze # single brand orange (see web repo design system)

# Teams mirror the functional Zendesk groups (2026-07 migration). The regional
# "Email Support X" Zendesk groups intentionally have no team — that routing
# becomes per-region email inboxes later. "GMB Reviews" has no Chatwoot
# equivalent (no Google-reviews channel) and stays outside. "Unclassified"
# maps to Chatwoot's built-in Unassigned pool.
TEAMS = [
  ['Booking Issues',             'General ticketing/PNR/payment issues'],
  ['Refunds',                    'Refund cancellations/payment reversals/refund status inquiries'],
  ['Cancellations & Reschedule', 'Customer chooses to cancel/reschedule'],
  ['IROP (Airline Initiated)',   'Airline-initiated flight cancellations/changes'],
  ['Group Fares',                'Group bookings and confirmations'],
  ['Chargebacks & Disputes',     'Card chargebacks and payment disputes'],
  ['Legal & Grievances',         'Legal notices and formal grievances'],
  ['Escalations',                'Supervisor escalation queue'],
  ['Tripshield Claims',          'Tripshield insurance claims'],
  ['Partners & B2B',             'Partner queries and B2B booking requests'],
].freeze

LABELS = %w[
  booking-issue refund cancellation reschedule irop group-fare chargeback
  legal escalation tripshield b2b payment-issue bot-handled
].freeze

account = Account.first!
bot = AgentBot.first!

TEAMS.each do |name, description|
  team = Team.find_or_initialize_by(account: account, name: name)
  team.description = description
  team.allow_auto_assign = true
  team.save!
end
puts "teams: #{account.teams.count}"

LABELS.each do |title|
  Label.find_or_create_by!(account: account, title: title) do |l|
    l.color = '#ef6614'
  end
end
puts "labels: #{account.labels.count}"

SITES.each do |name, url|
  inbox = account.inboxes.find_by(name: name)
  if inbox.nil?
    channel = Channel::WebWidget.create!(
      account: account,
      website_url: url,
      widget_color: WIDGET_COLOR,
      welcome_title: 'Hi there 👋',
      welcome_tagline: 'Tell us about your trip and we will help you out.'
    )
    inbox = Inbox.create!(account: account, channel: channel, name: name)
  end

  # Ticket-style behavior decided 2026-07-22: CSAT on resolve, resolved
  # threads locked, new message after resolve = new ticket.
  inbox.update!(
    csat_survey_enabled: true,
    allow_messages_after_resolved: false,
    lock_to_single_conversation: false
  )

  abi = AgentBotInbox.find_or_initialize_by(inbox: inbox, agent_bot: bot, account: account)
  abi.status = :active
  abi.save!

  account.users.each { |u| InboxMember.find_or_create_by!(inbox: inbox, user: u) }

  puts "#{inbox.id}|#{name}|#{inbox.channel.website_token}"
end
