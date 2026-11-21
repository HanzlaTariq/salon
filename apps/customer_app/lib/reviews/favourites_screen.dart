import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'review_api.dart';
import 'review_models.dart';
import 'review_widgets.dart';

/// Favourite salons. [onOpen] opens the salon profile (supplied by the caller, which owns the discovery and booking clients).
class FavouritesScreen extends StatefulWidget {
  const FavouritesScreen({super.key, required this.api, required this.onOpen});
  final ReviewApi api;
  final void Function(BuildContext context, FavouriteSalon salon) onOpen;

  @override
  State<FavouritesScreen> createState() => _FavouritesScreenState();
}

class _FavouritesScreenState extends State<FavouritesScreen> {
  late Future<List<FavouriteSalon>> _load = widget.api.favourites();

  void _reload() => setState(() => _load = widget.api.favourites());

  Future<void> _remove(FavouriteSalon s) async {
    try {
      await widget.api.removeFavourite(s.salonId);
      if (mounted) _reload();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Favourite salons')),
      body: FutureBuilder<List<FavouriteSalon>>(
        future: _load,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) return const LoadingView(label: 'Loading your favourites…');
          if (snap.hasError) {
            final e = snap.error;
            return ErrorView(message: e is ApiException ? e.message : 'Could not load your favourites.', requestId: e is ApiException ? e.requestId : null, onRetry: _reload);
          }
          final items = snap.data!;
          if (items.isEmpty) {
            return const EmptyView(icon: Icons.favorite_border, title: 'No favourites yet', message: 'Tap the heart on a salon to keep it here.');
          }
          return RefreshIndicator(
            onRefresh: () async => _reload(),
            child: ListView.separated(
              padding: const EdgeInsets.all(AppSpacing.lg),
              itemCount: items.length,
              separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.md),
              itemBuilder: (_, i) {
                final s = items[i];
                return Card(
                  clipBehavior: Clip.antiAlias,
                  child: InkWell(
                    onTap: () => widget.onOpen(context, s),
                    child: Row(children: [
                      SizedBox(
                        width: 88,
                        height: 88,
                        child: s.coverUrl == null
                            ? const ColoredBox(color: AppColors.sand, child: Icon(Icons.storefront_outlined))
                            : Image.network(s.coverUrl!, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const ColoredBox(color: AppColors.sand, child: Icon(Icons.storefront_outlined))),
                      ),
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsets.all(AppSpacing.md),
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(s.name, style: theme.textTheme.titleMedium, overflow: TextOverflow.ellipsis),
                            Text('${s.area}, ${s.city}', style: theme.textTheme.bodySmall, overflow: TextOverflow.ellipsis),
                            const SizedBox(height: AppSpacing.xs),
                            Row(children: [StarRow(rating: s.rating, size: 14), const SizedBox(width: AppSpacing.xs), Text(ratingLabel(s.rating, s.ratingCount), style: theme.textTheme.bodySmall)]),
                          ]),
                        ),
                      ),
                      IconButton(tooltip: 'Remove from favourites', icon: const Icon(Icons.favorite, color: AppColors.danger), onPressed: () => _remove(s)),
                    ]),
                  ),
                );
              },
            ),
          );
        },
      ),
    );
  }
}

/// Heart in an app bar: loads whether the salon is a favourite and toggles it. Errors are shown, never swallowed.
class FavouriteButton extends StatefulWidget {
  const FavouriteButton({super.key, required this.api, required this.salonId});
  final ReviewApi api;
  final String salonId;

  @override
  State<FavouriteButton> createState() => _FavouriteButtonState();
}

class _FavouriteButtonState extends State<FavouriteButton> {
  bool? _on;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    widget.api.favourites().then((list) {
      if (mounted) setState(() => _on = list.any((s) => s.salonId == widget.salonId));
    }).catchError((Object _) {
      if (mounted) setState(() => _on = false);
    });
  }

  Future<void> _toggle() async {
    final on = _on ?? false;
    setState(() => _busy = true);
    try {
      if (on) {
        await widget.api.removeFavourite(widget.salonId);
      } else {
        await widget.api.addFavourite(widget.salonId);
      }
      if (mounted) setState(() => _on = !on);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final on = _on ?? false;
    return IconButton(
      tooltip: on ? 'Remove from favourites' : 'Add to favourites',
      onPressed: _on == null || _busy ? null : _toggle,
      icon: Icon(on ? Icons.favorite : Icons.favorite_border, color: on ? AppColors.danger : null),
    );
  }
}
