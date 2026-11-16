import 'dart:async';

import 'package:flutter/material.dart';

import '../auth/auth_errors.dart';
import '../theme/tokens.dart';
import '../widgets/state_views.dart';
import 'notification_api.dart';
import 'notification_models.dart';
import 'push_messaging.dart';
import 'push_registrar.dart';

/// Called when a notification is tapped. Return true when the app opened a screen for it.
typedef NotificationOpenHandler = bool Function(BuildContext context, AppNotification notification);

IconData _iconFor(AppNotification n) => switch (n.category) {
      'REMINDERS' => Icons.alarm,
      'QUEUE' => Icons.hourglass_bottom,
      'TEAM' => Icons.group_outlined,
      'ACCOUNT' => Icons.verified_user_outlined,
      _ => Icons.event_note_outlined,
    };

/// The AppBar bell: unread badge (refreshed every minute and on every push), opens the inbox.
/// It also starts push registration for this signed-in screen, so a single line in each home screen wires everything.
class NotificationBell extends StatefulWidget {
  const NotificationBell({super.key, required this.api, required this.app, this.messaging, this.onOpen});

  final NotificationApi api;

  /// `CUSTOMER` or `BUSINESS`.
  final String app;

  /// Defaults to [FirebasePushMessaging]. Pass [NoPushMessaging] to switch push off (the inbox still works).
  final PushMessaging? messaging;
  final NotificationOpenHandler? onOpen;

  @override
  State<NotificationBell> createState() => _NotificationBellState();
}

class _NotificationBellState extends State<NotificationBell> {
  late final PushMessaging _messaging = widget.messaging ?? FirebasePushMessaging();
  late final PushRegistrar _registrar = PushRegistrar(api: widget.api, messaging: _messaging, app: widget.app);
  final List<StreamSubscription<PushEvent>> _subs = [];
  Timer? _timer;
  int _unread = 0;

  @override
  void initState() {
    super.initState();
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 60), (_) => _refresh());
    _startPush();
  }

  Future<void> _startPush() async {
    await _registrar.start();
    if (!mounted) return;
    _subs.add(_messaging.onForeground.listen((e) {
      _refresh();
      final text = [e.title, e.body].whereType<String>().join(' - ');
      if (mounted && text.isNotEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text, maxLines: 2, overflow: TextOverflow.ellipsis)));
      }
    }));
    _subs.add(_messaging.onOpened.listen((_) {
      if (mounted) _open();
    }));
    final initial = await _messaging.initialMessage();
    if (initial != null && mounted) _open();
  }

  @override
  void dispose() {
    _timer?.cancel();
    for (final s in _subs) {
      s.cancel();
    }
    _registrar.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    try {
      final n = await widget.api.unreadCount();
      if (mounted) setState(() => _unread = n);
    } on ApiException {
      // Keep the last number; the next refresh tries again.
    }
  }

  Future<void> _open() async {
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => NotificationsScreen(api: widget.api, app: widget.app, onOpen: widget.onOpen)));
    if (mounted) _refresh();
  }

  @override
  Widget build(BuildContext context) => IconButton(
        tooltip: 'Notifications',
        onPressed: _open,
        icon: Badge(
          isLabelVisible: _unread > 0,
          label: Text(_unread > 99 ? '99+' : '$_unread'),
          child: const Icon(Icons.notifications_outlined),
        ),
      );
}

/// The in-app history: newest first, unread in bold, pull to refresh, pages of 30, mark one or all as read.
class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key, required this.api, required this.app, this.onOpen});

  final NotificationApi api;
  final String app;
  final NotificationOpenHandler? onOpen;

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  final _scroll = ScrollController();
  final List<AppNotification> _items = [];
  String? _next;
  bool _loading = true;
  bool _loadingMore = false;
  ApiException? _error;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (_scroll.hasClients && _scroll.position.extentAfter < 300) _more();
    });
    _load();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await widget.api.inbox();
      if (!mounted) return;
      setState(() {
        _items
          ..clear()
          ..addAll(page.items);
        _next = page.nextCursor;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _error = e;
          _loading = false;
        });
      }
    }
  }

  Future<void> _more() async {
    if (_loadingMore || _next == null) return;
    setState(() => _loadingMore = true);
    try {
      final page = await widget.api.inbox(cursor: _next);
      if (!mounted) return;
      setState(() {
        _items.addAll(page.items);
        _next = page.nextCursor;
      });
    } on ApiException {
      // The next scroll tries again.
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  Future<void> _tap(int index) async {
    final n = _items[index];
    if (n.isUnread) {
      setState(() => _items[index] = n.markedRead(DateTime.now()));
      try {
        await widget.api.markRead(n.id);
      } on ApiException {
        // It stays unread on the server; the next refresh shows the truth.
      }
    }
    if (!mounted) return;
    widget.onOpen?.call(context, n);
  }

  Future<void> _readAll() async {
    try {
      await widget.api.markAllRead();
      await _load();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Notifications'),
        actions: [
          IconButton(tooltip: 'Mark all as read', icon: const Icon(Icons.done_all), onPressed: _items.any((n) => n.isUnread) ? _readAll : null),
          IconButton(
            tooltip: 'Notification settings',
            icon: const Icon(Icons.tune),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => NotificationSettingsScreen(api: widget.api, app: widget.app))),
          ),
        ],
      ),
      body: SafeArea(child: _body()),
    );
  }

  Widget _body() {
    if (_loading) return const LoadingView(label: 'Loading notifications...');
    if (_error != null) return ErrorView(message: _error!.message, requestId: _error!.requestId, onRetry: _load);
    if (_items.isEmpty) {
      return const EmptyView(title: 'No notifications yet', message: 'Booking updates, reminders and account notices will appear here.', icon: Icons.notifications_none);
    }
    final now = DateTime.now();
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        controller: _scroll,
        physics: const AlwaysScrollableScrollPhysics(),
        itemCount: _items.length + (_loadingMore ? 1 : 0),
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, i) {
          if (i >= _items.length) return const Padding(padding: EdgeInsets.all(AppSpacing.lg), child: Center(child: CircularProgressIndicator(strokeWidth: 2)));
          final n = _items[i];
          final rtl = looksRtl('${n.title} ${n.body}');
          final style = Theme.of(context).textTheme;
          return ListTile(
            onTap: () => _tap(i),
            leading: CircleAvatar(child: Icon(_iconFor(n))),
            title: Text(n.title, textDirection: rtl ? TextDirection.rtl : null, style: n.isUnread ? style.titleSmall?.copyWith(fontWeight: FontWeight.w700) : style.titleSmall),
            subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(n.body, textDirection: rtl ? TextDirection.rtl : null, maxLines: 3, overflow: TextOverflow.ellipsis),
              const SizedBox(height: AppSpacing.xs),
              Text(timeAgo(n.createdAt, now), style: style.bodySmall),
            ]),
            trailing: n.isUnread ? const Icon(Icons.circle, size: 10) : null,
            isThreeLine: true,
          );
        },
      ),
    );
  }
}

/// Which notifications a person gets, the language of the texts, and which reminders. Saved on the server.
class NotificationSettingsScreen extends StatefulWidget {
  const NotificationSettingsScreen({super.key, required this.api, required this.app});

  final NotificationApi api;
  final String app;

  @override
  State<NotificationSettingsScreen> createState() => _NotificationSettingsScreenState();
}

class _NotificationSettingsScreenState extends State<NotificationSettingsScreen> {
  NotificationPrefs? _prefs;
  ApiException? _error;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final p = await widget.api.preferences();
      if (mounted) setState(() => _prefs = p);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  Future<void> _save(NotificationPrefs next) async {
    final before = _prefs;
    setState(() {
      _prefs = next;
      _saving = true;
    });
    try {
      final saved = await widget.api.savePreferences(next);
      if (mounted) setState(() => _prefs = saved);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() => _prefs = before);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = _prefs;
    final customer = widget.app == 'CUSTOMER';
    return Scaffold(
      appBar: AppBar(title: const Text('Notification settings')),
      body: SafeArea(
        child: _error != null
            ? ErrorView(message: _error!.message, requestId: _error!.requestId, onRetry: _load)
            : p == null
                ? const LoadingView()
                : ListView(children: [
                    if (_saving) const LinearProgressIndicator(),
                    SwitchListTile(title: const Text('Push notifications'), subtitle: const Text('Off: nothing is sent to this phone; the inbox still keeps your notifications.'), value: p.pushEnabled, onChanged: (v) => _save(p.copyWith(pushEnabled: v))),
                    const Divider(),
                    ListTile(
                      title: const Text('Language of notifications'),
                      subtitle: Padding(
                        padding: const EdgeInsets.only(top: AppSpacing.sm),
                        child: SegmentedButton<String>(
                          segments: const [ButtonSegment(value: 'en', label: Text('English')), ButtonSegment(value: 'ur', label: Text('اردو'))],
                          selected: {p.language},
                          onSelectionChanged: (s) => _save(p.copyWith(language: s.first)),
                        ),
                      ),
                    ),
                    const Divider(),
                    SwitchListTile(title: Text(customer ? 'Booking updates' : 'Bookings and cancellations'), subtitle: Text(customer ? 'Confirmations, cancellations by the salon, completed visits.' : 'New bookings, cancellations and changes.'), value: p.bookings, onChanged: (v) => _save(p.copyWith(bookings: v))),
                    SwitchListTile(title: Text(customer ? 'Live queue updates' : 'Customer arrival updates'), subtitle: Text(customer ? 'Delays and early-availability offers.' : 'On the way, running late, early offers answered.'), value: p.queue, onChanged: (v) => _save(p.copyWith(queue: v))),
                    if (customer) SwitchListTile(title: const Text('Appointment reminders'), value: p.reminders, onChanged: (v) => _save(p.copyWith(reminders: v))),
                    if (customer && p.reminders)
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
                        child: Wrap(spacing: AppSpacing.sm, children: [
                          for (final o in kReminderOffsets)
                            FilterChip(
                              label: Text(o == 0 ? 'At the time' : '$o min before'),
                              selected: p.reminderOffsets.contains(o),
                              onSelected: (on) {
                                final next = {...p.reminderOffsets};
                                on ? next.add(o) : next.remove(o);
                                _save(p.copyWith(reminderOffsets: (next.toList()..sort((a, b) => b.compareTo(a)))));
                              },
                            ),
                        ]),
                      ),
                    if (!customer) SwitchListTile(title: const Text('Team'), subtitle: const Text('Staff joined, schedule changes.'), value: p.team, onChanged: (v) => _save(p.copyWith(team: v))),
                    if (!customer)
                      const ListTile(leading: Icon(Icons.info_outline), title: Text('Salon approval, payment and subscription notices are always sent.')),
                  ]),
      ),
    );
  }
}
