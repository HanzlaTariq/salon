import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import '../discovery/discovery_api.dart';
import '../discovery/format.dart';
import 'booking_api.dart';
import 'booking_detail_screen.dart';
import 'booking_models.dart';
import 'confirm_booking_screen.dart';

/// The customer's own bookings: Upcoming and Past. Everything shown comes from the server.
class MyBookingsScreen extends StatelessWidget {
  const MyBookingsScreen({super.key, required this.api, required this.discovery});

  final BookingApi api;
  final DiscoveryApi discovery;

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('My bookings'),
          bottom: const TabBar(tabs: [Tab(text: 'Upcoming'), Tab(text: 'Past')]),
        ),
        body: TabBarView(children: [
          _BookingList(api: api, discovery: discovery, scope: 'upcoming'),
          _BookingList(api: api, discovery: discovery, scope: 'past'),
        ]),
      ),
    );
  }
}

class _BookingList extends StatefulWidget {
  const _BookingList({required this.api, required this.discovery, required this.scope});
  final BookingApi api;
  final DiscoveryApi discovery;
  final String scope;

  @override
  State<_BookingList> createState() => _BookingListState();
}

class _BookingListState extends State<_BookingList> with AutomaticKeepAliveClientMixin {
  late Future<BookingPage> _load = widget.api.list(scope: widget.scope);

  @override
  bool get wantKeepAlive => true;

  void _reload() => setState(() => _load = widget.api.list(scope: widget.scope));

  Future<void> _open(Booking b) async {
    await Navigator.push(context, MaterialPageRoute<void>(builder: (_) => BookingDetailScreen(api: widget.api, discovery: widget.discovery, bookingId: b.id)));
    if (mounted) _reload();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return FutureBuilder<BookingPage>(
      future: _load,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) return const LoadingView(label: 'Loading your bookings…');
        if (snap.hasError) {
          final e = snap.error;
          return ErrorView(
            message: e is ApiException ? e.message : 'Could not load your bookings.',
            requestId: e is ApiException ? e.requestId : null,
            onRetry: _reload,
          );
        }
        final items = snap.data!.items;
        if (items.isEmpty) {
          return EmptyView(
            icon: Icons.event_available_outlined,
            title: widget.scope == 'upcoming' ? 'No upcoming bookings' : 'No past bookings',
            message: widget.scope == 'upcoming' ? 'Find a salon and book a time. It will appear here.' : 'Finished and cancelled bookings appear here.',
          );
        }
        return RefreshIndicator(
          onRefresh: () async => _reload(),
          child: ListView.separated(
            padding: const EdgeInsets.all(AppSpacing.lg),
            itemCount: items.length,
            separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.md),
            itemBuilder: (_, i) => _BookingCard(booking: items[i], onTap: () => _open(items[i])),
          ),
        );
      },
    );
  }
}

class _BookingCard extends StatelessWidget {
  const _BookingCard({required this.booking, required this.onTap});
  final Booking booking;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final day = DateTime.tryParse('${booking.date}T00:00:00Z');
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.card),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(booking.salonName, style: theme.textTheme.titleMedium, overflow: TextOverflow.ellipsis)),
              statusChip(context, booking),
            ]),
            const SizedBox(height: AppSpacing.xs),
            Text('${day == null ? booking.date : formatDay(day)} at ${formatClock(booking.time)} · ${booking.staffName}', style: theme.textTheme.bodyMedium),
            const SizedBox(height: AppSpacing.xs),
            Text(booking.services.map((s) => s.name).join(', '), style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText), maxLines: 2, overflow: TextOverflow.ellipsis),
            const SizedBox(height: AppSpacing.sm),
            Text(formatPkr(booking.totalPrice), style: theme.textTheme.titleSmall),
          ]),
        ),
      ),
    );
  }
}
