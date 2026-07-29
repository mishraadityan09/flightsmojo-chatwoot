# Idempotent provisioning for the whole FlightsMojo support setup.
# Run:  docker compose exec -T rails bundle exec rails runner - < scripts/provision.rb
#
# Recreates from scratch on any fresh install (this is the source of truth for
# DB state — we never copy the database between environments, we re-run this):
#   - the "FlightsMojo Assistant" agent bot  (prints BOT_TOKEN → bot/.env CHATWOOT_BOT_TOKEN)
#   - the booking_id conversation custom attribute (CRM/booking lookups)
#   - 10 functional teams + 13 labels (Zendesk-migration taxonomy)
#   - the 4 launch inboxes with ticket-style settings, bot attached
#     (prints id|name|website_token → web app NEXT_PUBLIC_CHATWOOT_TOKEN_*)
#   - every existing account user added to every inbox
# Safe to re-run any time: everything is find-or-create.

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

UNSOLVED = %w[open pending].freeze

# Chatwoot "folders" (saved filters) replacing the Zendesk Views sidebar.
# NOTE: CustomFilter belongs_to :user — unlike Zendesk's shared, admin-defined
# Views, folders are PER AGENT. So we create the same set for every user, and
# re-run this whenever an agent joins.
def filter_query(*clauses)
  payload = clauses.each_with_index.map do |(key, op, values), i|
    { 'attribute_key' => key, 'filter_operator' => op, 'values' => values,
      'query_operator' => (i == clauses.size - 1 ? nil : 'and'),
      'attribute_model' => 'standard' }
  end
  { 'payload' => payload }
end

account = Account.first!

# ── Agent bot (webhook target is the bot container on the compose network) ──
bot = AgentBot.find_or_initialize_by(account: account, name: 'FlightsMojo Assistant')
bot.description = 'Gemini-backed FAQ bot with human handoff'
bot.outgoing_url = 'http://bot:3002/webhook'
bot.save!
bot_token = (bot.access_token || AccessToken.create!(owner: bot)).token
puts "BOT_TOKEN=#{bot_token}   # → bot/.env CHATWOOT_BOT_TOKEN, then: docker compose up -d bot"

# ── Conversation custom attribute: booking_id (bot auto-stamps; CRM lookups) ──
cad = CustomAttributeDefinition.find_or_initialize_by(
  account: account, attribute_key: 'booking_id', attribute_model: :conversation_attribute
)
cad.attribute_display_name = 'Booking ID'
cad.attribute_display_type = :text
cad.save!
puts 'custom attribute: booking_id ready'

TEAMS.each do |name, description|
  # Team downcases its name in a before_validation hook, so look up by the
  # stored (downcased) form — matching on the title-case constant always misses
  # and then trips the uniqueness validation on re-run.
  team = Team.find_or_initialize_by(account: account, name: name.downcase)
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

# ── Folders (saved filters), mirroring the Zendesk Views sidebar ──
# Zendesk views with no Chatwoot equivalent are intentionally absent:
# "GMB Reviews" (no Google-reviews channel), the regional "Email Support X"
# views (no per-region email inboxes yet), and Suspended/Deleted tickets
# (Chatwoot has no suspension or soft-delete concept).
account.users.each do |user|
  folders = {
    'All Unsolved' => filter_query(['status', 'equal_to', UNSOLVED]),
    'Unassigned'   => filter_query(['status', 'equal_to', UNSOLVED],
                                   ['assignee_id', 'is_not_present', []]),
    'My Unsolved'  => filter_query(['status', 'equal_to', UNSOLVED],
                                   ['assignee_id', 'equal_to', [user.id]]),
    'Recently Solved' => filter_query(['status', 'equal_to', ['resolved']]),
    # Zendesk's "All Unclassified Tickets Not Routed" — the Unassigned pool.
    'Unclassified (No Team)' => filter_query(['status', 'equal_to', UNSOLVED],
                                             ['team_id', 'is_not_present', []])
  }

  account.teams.each do |team|
    folders["Unsolved — #{team.name.titleize}"] =
      filter_query(['status', 'equal_to', UNSOLVED],
                   ['team_id', 'equal_to', [team.id]])
  end

  folders.each do |name, query|
    cf = CustomFilter.find_or_initialize_by(
      account: account, user: user, filter_type: :conversation, name: name
    )
    cf.query = query
    cf.save!
  end
  puts "folders for #{user.email}: #{account.custom_filters.where(user: user).count}"
end
