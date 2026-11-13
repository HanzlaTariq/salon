import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_core/flutter_core.dart';

import 'availability_screen.dart';
import 'discovery_api.dart';
import 'discovery_models.dart';
import 'format.dart';
import 'salon_card.dart';

const _maxSelected = 10;

/// Salon profile: photos, hours, services with the exact price of every staff member (price comparison) and a
/// selection of services to check times for.
class SalonProfileScreen extends StatefulWidget {
  const SalonProfileScreen({super.key, required this.api, required this.card});

  final DiscoveryApi api;
  final SalonCard card;

  @override
  State<SalonProfileScreen> createState() => _SalonProfileScreenState();
}

class _SalonProfileScreenState extends State<SalonProfileScreen> {
  late Future<(SalonProfile, List<CatalogCategory>)> _load = _fetch();
  final Map<String, CatalogService> _selected = {};

  Future<(SalonProfile, List<CatalogCategory>)> _fetch() async {
    final results = await Future.wait<Object>([widget.api.salon(widget.card.id), widget.api.catalog(widget.card.id)]);
    return (results[0] as SalonProfile, results[1] as List<CatalogCategory>);
  }

  void _toggle(CatalogService s, bool on) {
    setState(() {
      if (on) {
        if (_selected.length >= _maxSelected) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('You can check up to 10 services at once.')));
          return;
        }
        _selected[s.id] = s;
      } else {
        _selected.remove(s.id);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.card.name, overflow: TextOverflow.ellipsis)),
      body: FutureBuilder<(SalonProfile, List<CatalogCategory>)>(
        future: _load,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) return const LoadingView(label: 'Loading salon…');
          if (snap.hasError) {
            final e = snap.error;
            final unavailable = e is ApiException && e.statusCode == 404;
            if (unavailable) return const EmptyView(icon: Icons.storefront_outlined, title: 'This salon is not available right now');
            return ErrorView(
              message: e is ApiException ? e.message : 'Could not load this salon.',
              requestId: e is ApiException ? e.requestId : null,
              onRetry: () => setState(() => _load = _fetch()),
            );
          }
          final (profile, catalog) = snap.data!;
          return Stack(children: [
            ListView(padding: EdgeInsets.only(bottom: _selected.isEmpty ? AppSpacing.xl : 110), children: [
              _Photos(photos: profile.photos, name: profile.name),
              Padding(padding: const EdgeInsets.all(AppSpacing.lg), child: _Info(profile: profile)),
              if (profile.openingHours != null) Padding(padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg), child: _Hours(hours: profile.openingHours!)),
              Padding(padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.xl, AppSpacing.lg, AppSpacing.sm), child: Text('Services', style: Theme.of(context).textTheme.titleLarge)),
              if (catalog.isEmpty)
                const Padding(padding: EdgeInsets.all(AppSpacing.lg), child: Text('This salon has not published any bookable services yet.'))
              else
                for (final cat in catalog) _Category(category: cat, selected: _selected.keys.toSet(), onToggle: _toggle),
            ]),
            if (_selected.isNotEmpty) Positioned(left: 0, right: 0, bottom: 0, child: _SelectionBar(selected: _selected.values.toList(), onContinue: () => _openAvailability(profile))),
          ]);
        },
      ),
    );
  }

  void _openAvailability(SalonProfile profile) {
    Navigator.push(
      context,
      MaterialPageRoute<void>(builder: (_) => AvailabilityScreen(api: widget.api, salonId: profile.id, salonName: profile.name, services: _selected.values.toList())),
    );
  }
}

class _Photos extends StatelessWidget {
  const _Photos({required this.photos, required this.name});
  final List<SalonPhoto> photos;
  final String name;

  @override
  Widget build(BuildContext context) {
    if (photos.isEmpty) {
      return AspectRatio(aspectRatio: 16 / 9, child: Container(color: Theme.of(context).colorScheme.surfaceContainerHighest, child: const Icon(Icons.content_cut, size: 48, color: AppColors.mutedText)));
    }
    final sorted = [...photos]..sort((a, b) => (b.isCover ? 1 : 0).compareTo(a.isCover ? 1 : 0));
    return AspectRatio(
      aspectRatio: 16 / 9,
      child: PageView(children: [
        for (final p in sorted)
          Image.network(
            p.url,
            fit: BoxFit.cover,
            semanticLabel: 'Photo of $name',
            errorBuilder: (_, __, ___) => Container(color: Theme.of(context).colorScheme.surfaceContainerHighest, child: const Icon(Icons.broken_image_outlined)),
          ),
      ]),
    );
  }
}

class _Info extends StatelessWidget {
  const _Info({required this.profile});
  final SalonProfile profile;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(profile.name, style: theme.textTheme.headlineSmall),
      const SizedBox(height: AppSpacing.xs),
      Text('${salonTypeLabels[profile.salonType] ?? profile.salonType} salon', style: theme.textTheme.bodyMedium?.copyWith(color: AppColors.mutedText)),
      const SizedBox(height: AppSpacing.md),
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Icon(Icons.place_outlined, size: 20),
        const SizedBox(width: AppSpacing.sm),
        Expanded(child: Text('${profile.addressLine}, ${profile.area}, ${profile.city}')),
      ]),
      const SizedBox(height: AppSpacing.sm),
      Row(children: [
        const Icon(Icons.call_outlined, size: 20),
        const SizedBox(width: AppSpacing.sm),
        Expanded(child: Text(profile.phone)),
        IconButton(
          tooltip: 'Copy phone number',
          icon: const Icon(Icons.copy, size: 20),
          onPressed: () async {
            await Clipboard.setData(ClipboardData(text: profile.phone));
            if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Phone number copied')));
          },
        ),
      ]),
      if (profile.description != null && profile.description!.isNotEmpty) ...[const SizedBox(height: AppSpacing.md), Text(profile.description!)],
    ]);
  }
}

class _Hours extends StatelessWidget {
  const _Hours({required this.hours});
  final List<DayHours> hours;

  @override
  Widget build(BuildContext context) {
    final sorted = [...hours]..sort((a, b) => a.weekday.compareTo(b.weekday));
    return Card(
      margin: EdgeInsets.zero,
      child: ExpansionTile(
        title: const Text('Opening hours'),
        childrenPadding: const EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.md),
        children: [
          for (final d in sorted)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
              child: Row(children: [
                SizedBox(width: 56, child: Text(weekdayShort(d.weekday))),
                Text(d.closed || d.opensAt == null || d.closesAt == null ? 'Closed' : '${formatClock(d.opensAt!)} - ${formatClock(d.closesAt!)}'),
              ]),
            ),
        ],
      ),
    );
  }
}

class _Category extends StatelessWidget {
  const _Category({required this.category, required this.selected, required this.onToggle});
  final CatalogCategory category;
  final Set<String> selected;
  final void Function(CatalogService, bool) onToggle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.sm),
      child: Card(
        margin: EdgeInsets.zero,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.lg, AppSpacing.lg, AppSpacing.xs), child: Text(category.name, style: theme.textTheme.titleMedium)),
          for (final s in category.services)
            CheckboxListTile(
              value: selected.contains(s.id),
              onChanged: (v) => onToggle(s, v ?? false),
              controlAffinity: ListTileControlAffinity.leading,
              title: Text(s.name),
              subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${formatDuration(s.durationMinutes)} · ${s.priceFrom == null ? '' : formatPriceRange(s.priceFrom!, s.priceTo ?? s.priceFrom!)}'),
                if (s.staff.length > 1)
                  Padding(
                    padding: const EdgeInsets.only(top: AppSpacing.xs),
                    child: Wrap(spacing: AppSpacing.md, children: [
                      for (final st in s.staffByPrice) Text('${st.name} ${formatPkr(st.price)}', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText)),
                    ]),
                  ),
              ]),
            ),
        ]),
      ),
    );
  }
}

class _SelectionBar extends StatelessWidget {
  const _SelectionBar({required this.selected, required this.onContinue});
  final List<CatalogService> selected;
  final VoidCallback onContinue;

  @override
  Widget build(BuildContext context) {
    final minutes = selected.fold<int>(0, (a, s) => a + s.durationMinutes);
    return Material(
      elevation: 8,
      color: Theme.of(context).colorScheme.surface,
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Row(children: [
            Expanded(child: Text('${selected.length} ${selected.length == 1 ? 'service' : 'services'} · ${formatDuration(minutes)}', style: Theme.of(context).textTheme.titleSmall)),
            FilledButton(onPressed: onContinue, child: const Text('See times and prices')),
          ]),
        ),
      ),
    );
  }
}
